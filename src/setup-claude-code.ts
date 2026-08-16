#!/usr/bin/env node

import { execFile } from "node:child_process";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CLAUDE_CODE_RESTART_HINT,
  CLAUDE_CODE_SERVER_NAME,
  claudeCodeIntegration,
  createClaudeCodeInstallPlan,
  renderClaudeCodeOperation,
  upsertClaudeCodeMcpConfig,
  verifyClaudeCodeMcpConfig,
} from "./claude-code-integration.js";
import type { InstallInstructionsOperation, InstallPlan, UpsertMcpServerOperation } from "./caller-integration.js";
import { loadConfig } from "./config.js";
import { DshClient } from "./dsh-client.js";
import { probeDshCliVersion, runDoctor } from "./doctor.js";
import { atomicInstallText, readConfigSnapshot } from "./setup-engine.js";
import type { ConfigSnapshot } from "./setup-engine.js";

const execFileAsync = promisify(execFile);
const DEFAULT_HOST_URL = "http://127.0.0.1:3080";
const DEFAULT_PRESET = "code";
const MIN_REQUIRES_USER_INTERACTION_VERSION = "2.1.199";
const CLAUDE_CODE_SKILL_RELATIVE_PATH = ".claude/skills/claude-code-dsh/SKILL.md";

export {
  CLAUDE_CODE_SERVER_NAME as SERVER_NAME,
  claudeCodeIntegration,
  createClaudeCodeInstallPlan,
  renderClaudeCodeOperation,
  upsertClaudeCodeMcpConfig,
  verifyClaudeCodeMcpConfig,
} from "./claude-code-integration.js";
export { readConfigSnapshot } from "./setup-engine.js";
export type { ConfigSnapshot } from "./setup-engine.js";

export interface SetupClaudeCodeOptions {
  yes: boolean;
  replace: boolean;
  replaceSkill: boolean;
  noSkill: boolean;
  dryRun: boolean;
  skipDoctor: boolean;
  noPreset: boolean;
  help: boolean;
  host?: string;
  preset?: string;
  projectPath?: string;
}

export interface InstallClaudeCodeConfigResult {
  changed: boolean;
  backupPath?: string;
  skill?: InstallClaudeCodeSkillResult;
}

export interface InstallClaudeCodeSkillResult extends InstallClaudeCodeConfigResult {
  path: string;
}

function valueAfter(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export function parseSetupArgs(argv: string[]): SetupClaudeCodeOptions {
  const options: SetupClaudeCodeOptions = {
    yes: false,
    replace: false,
    replaceSkill: false,
    noSkill: false,
    dryRun: false,
    skipDoctor: false,
    noPreset: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--yes" || argument === "-y") options.yes = true;
    else if (argument === "--replace") options.replace = true;
    else if (argument === "--replace-skill") options.replaceSkill = true;
    else if (argument === "--no-skill") options.noSkill = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--skip-doctor") options.skipDoctor = true;
    else if (argument === "--no-preset") options.noPreset = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--host") {
      options.host = valueAfter(argv, index, argument);
      index += 1;
    } else if (argument?.startsWith("--host=")) options.host = argument.slice("--host=".length);
    else if (argument === "--preset") {
      options.preset = valueAfter(argv, index, argument);
      index += 1;
    } else if (argument?.startsWith("--preset=")) options.preset = argument.slice("--preset=".length);
    else if (argument === "--project") {
      options.projectPath = valueAfter(argv, index, argument);
      index += 1;
    } else if (argument?.startsWith("--project=")) options.projectPath = argument.slice("--project=".length);
    else throw new Error(`unknown option: ${argument}`);
  }

  if (options.noPreset && options.preset !== undefined) {
    throw new Error("--preset and --no-preset cannot be used together");
  }
  if (options.noSkill && options.replaceSkill) {
    throw new Error("--replace-skill and --no-skill cannot be used together");
  }
  return options;
}

function firstClaudeCodeOperation(plan: InstallPlan): UpsertMcpServerOperation {
  const operation = plan.operations[0];
  if (operation?.kind !== "upsert-mcp-server") {
    throw new Error("Claude Code install plan is missing an MCP server operation");
  }
  return operation;
}

function firstClaudeCodeSkillOperation(plan: InstallPlan): InstallInstructionsOperation | undefined {
  return plan.operations.find(
    (operation): operation is InstallInstructionsOperation => operation.kind === "install-instructions",
  );
}

function replaceSkillFromConflictPolicy(operation: InstallInstructionsOperation): boolean {
  if (operation.conflictPolicy === "fail") return false;
  if (operation.conflictPolicy === "replace-explicitly") return true;
  throw new Error(`unsupported instruction conflict policy: ${operation.conflictPolicy as string}`);
}

function projectRootFromSkillTarget(targetPath: string): string {
  return dirname(dirname(dirname(dirname(targetPath))));
}

export async function installClaudeCodePlan(
  plan: InstallPlan,
  expected?: ConfigSnapshot,
): Promise<InstallClaudeCodeConfigResult> {
  const operation = firstClaudeCodeOperation(plan);
  const snapshot = expected ?? (await readConfigSnapshot(plan.target.path));
  const skill = firstClaudeCodeSkillOperation(plan);
  const skillProjectRoot = skill === undefined ? undefined : projectRootFromSkillTarget(skill.targetPath);
  if (skill !== undefined && skillProjectRoot !== undefined) {
    await assertExistingParentDirectoriesAreNotSymlinks(skill.targetPath, skillProjectRoot);
  }
  const skillSnapshot = skill === undefined ? undefined : await readConfigSnapshot(skill.targetPath);
  if (skill !== undefined) {
    prepareClaudeCodeSkillInstall(
      skillSnapshot as ConfigSnapshot,
      skill.content,
      replaceSkillFromConflictPolicy(skill),
      skill.targetPath,
    );
  }
  const mcpAlreadyCurrent = verifyClaudeCodeMcpConfig(snapshot.content, operation);
  const skillAlreadyCurrent = skill === undefined || skillSnapshot?.content === skill.content;
  const mcpContent = mcpAlreadyCurrent ? undefined : upsertClaudeCodeMcpConfig(snapshot.content, operation);
  if (mcpAlreadyCurrent && skillAlreadyCurrent) {
    return {
      changed: false,
      ...(skill === undefined ? {} : { skill: { changed: false, path: skill.targetPath } }),
    };
  }
  if (skill === undefined) {
    return mcpContent === undefined
      ? { changed: false }
      : await atomicInstallText({
          path: plan.target.path,
          content: mcpContent,
          expected: snapshot,
          backupLabel: "dsh-agentlink",
          tempLabel: "dsh-agentlink",
          verify: (content) => claudeCodeIntegration.verifyInstalled(content, operation),
        });
  }

  const skillResult = skillAlreadyCurrent
    ? { changed: false, path: skill.targetPath }
    : await installClaudeCodeSkill({
        projectRoot: projectRootFromSkillTarget(skill.targetPath),
        replaceSkill: replaceSkillFromConflictPolicy(skill),
        content: skill.content,
        ...(skillSnapshot === undefined ? {} : { expected: skillSnapshot }),
      });
  let result: InstallClaudeCodeConfigResult;
  try {
    result =
      mcpContent === undefined
        ? { changed: false }
        : await atomicInstallText({
            path: plan.target.path,
            content: mcpContent,
            expected: snapshot,
            backupLabel: "dsh-agentlink",
            tempLabel: "dsh-agentlink",
            verify: (content) => claudeCodeIntegration.verifyInstalled(content, operation),
          });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (skillResult.changed) {
      throw new Error(`Claude skill was installed, but MCP configuration failed: ${message}. Rerun setup after reviewing the config.`);
    }
    throw error;
  }
  if (skill === undefined) return result;
  return { ...result, changed: result.changed || skillResult.changed, skill: skillResult };
}

function canonicalClaudeCodeSkillSourcePath(): string {
  return fileURLToPath(new URL("../skill/claude-code-dsh/SKILL.md", import.meta.url));
}

export function claudeCodeSkillTargetPath(projectRoot: string): string {
  return join(projectRoot, CLAUDE_CODE_SKILL_RELATIVE_PATH);
}

export async function readCanonicalClaudeCodeSkill(): Promise<string> {
  return readFile(canonicalClaudeCodeSkillSourcePath(), "utf8");
}

async function assertExistingParentDirectoriesAreNotSymlinks(targetPath: string, projectRoot: string): Promise<void> {
  const parents = [
    join(projectRoot, ".claude"),
    join(projectRoot, ".claude", "skills"),
    dirname(targetPath),
  ];
  for (const parent of parents) {
    let details: Awaited<ReturnType<typeof lstat>>;
    try {
      details = await lstat(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (details.isSymbolicLink()) {
      throw new Error(`refusing to install Claude skill through symlinked directory: ${parent}`);
    }
    if (!details.isDirectory()) {
      throw new Error(`Claude skill parent path is not a directory: ${parent}`);
    }
  }
}

function prepareClaudeCodeSkillInstall(
  snapshot: ConfigSnapshot,
  content: string,
  replaceSkill: boolean,
  targetPath: string,
): string | undefined {
  if (snapshot.exists && snapshot.content === content) return undefined;
  if (snapshot.exists && !replaceSkill) {
    throw new Error(
      `Claude Code skill already exists at ${targetPath}; rerun with --replace-skill after reviewing it, or use --no-skill`,
    );
  }
  return content;
}

export async function installClaudeCodeSkill(options: {
  projectRoot: string;
  replaceSkill: boolean;
  expected?: ConfigSnapshot;
  content?: string;
}): Promise<InstallClaudeCodeSkillResult> {
  const targetPath = claudeCodeSkillTargetPath(options.projectRoot);
  await assertExistingParentDirectoriesAreNotSymlinks(targetPath, options.projectRoot);
  const content = options.content ?? (await readCanonicalClaudeCodeSkill());
  const snapshot = options.expected ?? (await readConfigSnapshot(targetPath));
  const prepared = prepareClaudeCodeSkillInstall(snapshot, content, options.replaceSkill, targetPath);
  if (prepared === undefined) return { changed: false, path: targetPath };
  const result = await atomicInstallText({
    path: targetPath,
    content: prepared,
    expected: snapshot,
    backupLabel: "dsh-agentlink-skill",
    tempLabel: "dsh-agentlink-skill",
    verify: (installed) => installed === content,
  });
  return { ...result, path: targetPath };
}

function normalizeHostUrl(raw: string): string {
  return loadConfig({ DSH_HOST_URL: raw, DSH_BRIDGE_TIME_ZONE: "UTC" }).hostUrl;
}

function normalizePreset(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === "" || value === "-") return undefined;
  if (/\r|\n|\0/.test(value)) throw new Error("preset must be a single line");
  return value;
}

export function parseClaudeCodeVersion(output: string): string | undefined {
  const match = output.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/);
  return match?.[1];
}

interface ParsedClaudeCodeVersion {
  core: [number, number, number];
  prerelease: boolean;
}

function parseComparableClaudeCodeVersion(version: string): ParsedClaudeCodeVersion | undefined {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (match === null) return undefined;
  const core = [
    Number.parseInt(match[1] as string, 10),
    Number.parseInt(match[2] as string, 10),
    Number.parseInt(match[3] as string, 10),
  ] as [number, number, number];
  if (core.some((component) => !Number.isSafeInteger(component))) return undefined;
  return { core, prerelease: match[4] !== undefined };
}

export function claudeCodeSupportsHumanApprovalPrompt(version: string | undefined): boolean | undefined {
  if (version === undefined) return undefined;
  const detected = parseComparableClaudeCodeVersion(version);
  const minimum = parseComparableClaudeCodeVersion(MIN_REQUIRES_USER_INTERACTION_VERSION);
  if (detected === undefined || minimum === undefined) return false;
  // Approval-prompt behavior is security-sensitive; fail closed for prerelease builds.
  if (detected.prerelease) return false;
  for (let index = 0; index < detected.core.length; index += 1) {
    if ((detected.core[index] as number) > (minimum.core[index] as number)) return true;
    if ((detected.core[index] as number) < (minimum.core[index] as number)) return false;
  }
  return true;
}

export function describeClaudeCodeApprovalCapability(version: string | undefined): string {
  const supported = claudeCodeSupportsHumanApprovalPrompt(version);
  if (supported === true) return `supported (${version}, requires Claude Code ${MIN_REQUIRES_USER_INTERACTION_VERSION}+)`;
  if (supported === false) {
    return `unsupported (${version ?? "unparseable"}, requires Claude Code ${MIN_REQUIRES_USER_INTERACTION_VERSION}+)`;
  }
  return `unknown (claude --version unavailable; requires Claude Code ${MIN_REQUIRES_USER_INTERACTION_VERSION}+)`;
}

export async function probeClaudeCodeVersion(): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync("claude", ["--version"], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    return parseClaudeCodeVersion(`${stdout}\n${stderr}`);
  } catch {
    return undefined;
  }
}

export async function resolveClaudeCodeProjectRoot(
  projectPath: string | undefined,
  currentWorkingDirectory: string,
): Promise<string> {
  const candidate = resolve(currentWorkingDirectory, projectPath ?? ".");
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch {
    throw new Error(`Claude Code project directory does not exist: ${candidate}`);
  }
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error(`Claude Code project path is not a directory: ${candidate}`);
  }
  return canonical;
}

async function askWithDefault(question: string, fallback: string): Promise<string> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await prompt.question(`${question} [${fallback}]: `)).trim();
    return answer === "" ? fallback : answer;
  } finally {
    prompt.close();
  }
}

async function askYesNo(question: string): Promise<boolean> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await prompt.question(`${question} [y/N]: `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
}

function printHelp(): void {
  console.log(`dsh-Agentlink Claude Code setup

Usage:
  npm run setup:claude
  npm run setup:claude -- --yes

Options:
  --host <url>       DSH Web Host origin (default: ${DEFAULT_HOST_URL})
  --preset <name>    DSH agent preset (default: ${DEFAULT_PRESET})
  --no-preset        Follow DSH's own default preset
  --project <path>   Target project root (default: current directory)
  --replace          Replace an existing ${CLAUDE_CODE_SERVER_NAME} configuration
  --replace-skill    Replace an existing Claude project skill after review
  --no-skill         Do not install the Claude project skill
  --dry-run          Print the generated MCP server block without writing
  --skip-doctor      Skip the read-only DSH Host check
  --yes, -y          Use defaults without interactive questions
  --help, -h         Show this help`);
}

function reportDshPermissionBoundary(): void {
  console.log("DSH permission/sandbox: Host-controlled; setup does not change or verify it");
}

function reportClaudeSkillStatus(result: InstallClaudeCodeSkillResult | "skipped" | "would-install" | "would-replace" | "already-current", projectRoot: string): void {
  const target = claudeCodeSkillTargetPath(projectRoot);
  if (result === "skipped") {
    console.log("Claude skill: skipped (--no-skill)");
  } else if (result === "would-install") {
    console.log(`Claude skill: would install ${target}`);
  } else if (result === "would-replace") {
    console.log(`Claude skill: would replace ${target} with backup`);
  } else if (result === "already-current") {
    console.log(`Claude skill: already current (${target})`);
  } else {
    console.log(`Claude skill: ${result.changed ? "installed" : "already current"} (${result.path})`);
    if (result.backupPath !== undefined) console.log(`Claude skill backup: ${result.backupPath}`);
  }
}

async function reportDshHostReachability(
  hostUrl: string,
  dshVersion: string,
  preset: string | undefined,
): Promise<void> {
  const config = loadConfig({
    DSH_HOST_URL: hostUrl,
    DSH_HOST_VERSION: dshVersion,
    DSH_BRIDGE_TIME_ZONE: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(preset === undefined ? {} : { DSH_BRIDGE_AGENT_PRESET: preset }),
  });
  const report = await runDoctor(config, new DshClient(config.hostUrl, config.requestTimeoutMs), async () => dshVersion);
  if (report.ok) {
    console.log(`DSH Host reachability: reachable (${report.compatibility})`);
  } else if ("availability" in report && report.availability === "host_unreachable") {
    console.log(`DSH Host reachability: unreachable; start it yourself with ${report.startCommand}`);
  } else {
    console.log(`DSH Host reachability: reachable but incompatible (${report.compatibility})`);
  }
}

async function main(): Promise<void> {
  const options = parseSetupArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.yes && !stdin.isTTY) {
    throw new Error("interactive input is unavailable; rerun with --yes and explicit flags if needed");
  }

  const majorNodeVersion = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (majorNodeVersion < 22) throw new Error(`Node.js 22 or newer is required; detected ${process.versions.node}`);

  const dshVersion = await probeDshCliVersion();
  if (dshVersion === undefined) {
    throw new Error("DSH CLI was not found. Install DSH and make sure `dsh --version` works before setup.");
  }

  const rawHost = options.host ?? (options.yes ? DEFAULT_HOST_URL : await askWithDefault("DSH Web Host", DEFAULT_HOST_URL));
  const hostUrl = normalizeHostUrl(rawHost);
  const rawPreset = options.noPreset
    ? undefined
    : options.preset ?? (options.yes ? DEFAULT_PRESET : await askWithDefault("DSH agent preset (`-` uses DSH default)", DEFAULT_PRESET));
  const preset = normalizePreset(rawPreset);
  const projectRoot = await resolveClaudeCodeProjectRoot(options.projectPath, process.cwd());
  const configPath = claudeCodeIntegration.defaultConfigPath({ cwd: projectRoot, env: process.env });
  const entryPath = await realpath(fileURLToPath(new URL("./index.js", import.meta.url)));
  const claudeVersion = await probeClaudeCodeVersion();
  const approvalCapability = claudeCodeSupportsHumanApprovalPrompt(claudeVersion);

  if (!options.dryRun && approvalCapability === false) {
    throw new Error(
      `Claude Code ${claudeVersion ?? "version"} does not support the required human approval prompt metadata; upgrade to ${MIN_REQUIRES_USER_INTERACTION_VERSION} or newer before setup.`,
    );
  }

  const skillContent = options.noSkill ? undefined : await readCanonicalClaudeCodeSkill();
  const buildPlan = (replace: boolean) =>
    claudeCodeIntegration.createInstallPlan({
      cwd: projectRoot,
      entryPath,
      nodePath: process.execPath,
      hostUrl,
      dshVersion,
      replace,
      installSkill: !options.noSkill,
      replaceSkill: options.replaceSkill,
      ...(skillContent === undefined ? {} : { skillSourcePath: canonicalClaudeCodeSkillSourcePath(), skillContent }),
      ...(preset === undefined ? {} : { preset }),
    });

  let plan = buildPlan(options.replace);
  let operation = firstClaudeCodeOperation(plan);
  const snapshot = await readConfigSnapshot(configPath);
  const mcpAlreadyCurrent = verifyClaudeCodeMcpConfig(snapshot.content, operation);
  let mcpConflictError: Error | undefined;

  if (!mcpAlreadyCurrent) {
    try {
      upsertClaudeCodeMcpConfig(snapshot.content, operation);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("already exists")) throw error;
      mcpConflictError = error instanceof Error ? error : new Error(message);
    }
  }

  let replace = options.replace;
  if (!mcpAlreadyCurrent && mcpConflictError !== undefined && !replace) {
    if (options.yes) throw mcpConflictError;
    replace = await askYesNo(`Replace the existing ${CLAUDE_CODE_SERVER_NAME} or legacy dsh_collab configuration?`);
    if (!replace) {
      console.log("No changes made.");
      return;
    }
    plan = buildPlan(true);
    operation = firstClaudeCodeOperation(plan);
    upsertClaudeCodeMcpConfig(snapshot.content, operation);
  }

  const skillOperation = firstClaudeCodeSkillOperation(plan);
  if (skillOperation !== undefined) {
    await assertExistingParentDirectoriesAreNotSymlinks(skillOperation.targetPath, projectRoot);
  }
  const skillSnapshot = skillOperation === undefined ? undefined : await readConfigSnapshot(skillOperation.targetPath);
  if (skillOperation !== undefined) {
    prepareClaudeCodeSkillInstall(
      skillSnapshot as ConfigSnapshot,
      skillOperation.content,
      replaceSkillFromConflictPolicy(skillOperation),
      skillOperation.targetPath,
    );
  }
  const skillWouldChange = skillOperation !== undefined && skillSnapshot?.content !== skillOperation.content;
  const mcpWouldChange = !mcpAlreadyCurrent;

  if (!mcpWouldChange && !skillWouldChange) {
    console.log(`${CLAUDE_CODE_SERVER_NAME} already matches this setup. No changes made.`);
    console.log("MCP registration: already current");
    console.log("Project /mcp trust: unknown until approved interactively in Claude Code");
    reportClaudeSkillStatus(options.noSkill ? "skipped" : "already-current", projectRoot);
    reportDshPermissionBoundary();
    console.log(`Claude approval capability: ${describeClaudeCodeApprovalCapability(claudeVersion)}`);
    if (options.skipDoctor) console.log("DSH Host reachability: not checked (--skip-doctor)");
    else await reportDshHostReachability(hostUrl, dshVersion, preset);
    console.log(CLAUDE_CODE_RESTART_HINT);
    return;
  }

  if (options.dryRun) {
    console.log(`# Would update ${plan.target.path}`);
    console.log(JSON.stringify({ mcpServers: { [operation.serverName]: renderClaudeCodeOperation(operation) } }, null, 2));
    console.log(`MCP registration: ${mcpWouldChange ? "would be configured" : "already current"}`);
    console.log("Project /mcp trust: unknown until approved interactively in Claude Code");
    reportClaudeSkillStatus(
      options.noSkill
        ? "skipped"
        : !skillWouldChange
          ? "already-current"
          : skillSnapshot?.exists
            ? "would-replace"
            : "would-install",
      projectRoot,
    );
    reportDshPermissionBoundary();
    console.log(`Claude approval capability: ${describeClaudeCodeApprovalCapability(claudeVersion)}`);
    console.log("DSH Host reachability: not checked during dry-run");
    return;
  }

  const installation = await installClaudeCodePlan(plan, snapshot);
  console.log(`Setup changed: ${installation.changed ? "yes" : "already current"}`);
  console.log(`Config path: ${configPath}`);
  if (installation.backupPath !== undefined) console.log(`Backup: ${installation.backupPath}`);
  console.log(`MCP registration: ${mcpWouldChange ? "configured" : "already current"}`);
  console.log("Project /mcp trust: unknown until approved interactively in Claude Code");
  reportClaudeSkillStatus(options.noSkill ? "skipped" : (installation.skill ?? "already-current"), projectRoot);
  reportDshPermissionBoundary();
  console.log(`Claude approval capability: ${describeClaudeCodeApprovalCapability(claudeVersion)}`);
  console.log(`DSH CLI: ${dshVersion}`);
  console.log(`DSH Host: ${hostUrl}`);
  console.log(`DSH agent preset (composition; not sandbox): ${preset ?? "Host default"}`);

  if (options.skipDoctor) console.log("DSH Host reachability: not checked (--skip-doctor)");
  else await reportDshHostReachability(hostUrl, dshVersion, preset);

  console.log(CLAUDE_CODE_RESTART_HINT);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error) => {
    console.error(`Claude Code setup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
