#!/usr/bin/env node

import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
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
import type { InstallPlan, UpsertMcpServerOperation } from "./caller-integration.js";
import { loadConfig } from "./config.js";
import { DshClient } from "./dsh-client.js";
import { probeDshCliVersion, runDoctor } from "./doctor.js";
import { atomicInstallText, readConfigSnapshot } from "./setup-engine.js";
import type { ConfigSnapshot } from "./setup-engine.js";

const execFileAsync = promisify(execFile);
const DEFAULT_HOST_URL = "http://127.0.0.1:3080";
const DEFAULT_PRESET = "code";
const MIN_REQUIRES_USER_INTERACTION_VERSION = "2.1.199";

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
    dryRun: false,
    skipDoctor: false,
    noPreset: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--yes" || argument === "-y") options.yes = true;
    else if (argument === "--replace") options.replace = true;
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
  return options;
}

function firstClaudeCodeOperation(plan: InstallPlan): UpsertMcpServerOperation {
  const operation = plan.operations[0];
  if (operation?.kind !== "upsert-mcp-server") {
    throw new Error("Claude Code install plan is missing an MCP server operation");
  }
  return operation;
}

export async function installClaudeCodePlan(
  plan: InstallPlan,
  expected?: ConfigSnapshot,
): Promise<InstallClaudeCodeConfigResult> {
  const operation = firstClaudeCodeOperation(plan);
  const snapshot = expected ?? (await readConfigSnapshot(plan.target.path));
  if (verifyClaudeCodeMcpConfig(snapshot.content, operation)) return { changed: false };

  const updated = upsertClaudeCodeMcpConfig(snapshot.content, operation);
  const result = await atomicInstallText({
    path: plan.target.path,
    content: updated,
    expected: snapshot,
    backupLabel: "dsh-agentlink",
    tempLabel: "dsh-agentlink",
    verify: (content) => claudeCodeIntegration.verifyInstalled(content, operation),
  });
  return result;
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
  --dry-run          Print the generated MCP server block without writing
  --skip-doctor      Skip the read-only DSH Host check
  --yes, -y          Use defaults without interactive questions
  --help, -h         Show this help`);
}

function reportClaudeSkillInstallation(projectRoot: string): void {
  const source = fileURLToPath(new URL("../skill/claude-code-dsh/SKILL.md", import.meta.url));
  const target = join(projectRoot, ".claude", "skills", "claude-code-dsh", "SKILL.md");
  console.log(`Claude skill: manual; review ${source} before installing it at ${target}. Setup does not overwrite skills.`);
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

  let plan = claudeCodeIntegration.createInstallPlan({
    cwd: projectRoot,
    entryPath,
    nodePath: process.execPath,
    hostUrl,
    dshVersion,
    replace: options.replace,
    ...(preset === undefined ? {} : { preset }),
  });
  let operation = firstClaudeCodeOperation(plan);

  const snapshot = await readConfigSnapshot(configPath);
  if (verifyClaudeCodeMcpConfig(snapshot.content, operation)) {
    console.log(`${CLAUDE_CODE_SERVER_NAME} already matches this setup. No changes made.`);
    console.log("MCP registration: already current");
    console.log("Project /mcp trust: unknown until approved interactively in Claude Code");
    reportClaudeSkillInstallation(projectRoot);
    console.log(`Claude approval capability: ${describeClaudeCodeApprovalCapability(claudeVersion)}`);
    if (options.skipDoctor) console.log("DSH Host reachability: not checked (--skip-doctor)");
    else await reportDshHostReachability(hostUrl, dshVersion, preset);
    console.log(CLAUDE_CODE_RESTART_HINT);
    return;
  }

  let replace = options.replace;
  if (!replace) {
    try {
      upsertClaudeCodeMcpConfig(snapshot.content, operation);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("already exists")) throw error;
      if (options.yes) throw error;
      replace = await askYesNo(`Replace the existing ${CLAUDE_CODE_SERVER_NAME} or legacy dsh_collab configuration?`);
      if (!replace) {
        console.log("No changes made.");
        return;
      }
      plan = claudeCodeIntegration.createInstallPlan({
        cwd: projectRoot,
        entryPath,
        nodePath: process.execPath,
        hostUrl,
        dshVersion,
        replace,
        ...(preset === undefined ? {} : { preset }),
      });
      operation = firstClaudeCodeOperation(plan);
    }
  }

  if (options.dryRun) {
    upsertClaudeCodeMcpConfig(snapshot.content, operation);
    console.log(`# Would update ${plan.target.path}`);
    console.log(JSON.stringify({ mcpServers: { [operation.serverName]: renderClaudeCodeOperation(operation) } }, null, 2));
    console.log("MCP registration: would be configured");
    console.log("Project /mcp trust: unknown until approved interactively in Claude Code");
    reportClaudeSkillInstallation(projectRoot);
    console.log(`Claude approval capability: ${describeClaudeCodeApprovalCapability(claudeVersion)}`);
    console.log("DSH Host reachability: not checked during dry-run");
    return;
  }

  const installation = await installClaudeCodePlan(plan, snapshot);
  console.log(`Config installed: ${installation.changed ? "yes" : "already current"}`);
  console.log(`Config path: ${configPath}`);
  if (installation.backupPath !== undefined) console.log(`Backup: ${installation.backupPath}`);
  console.log(`MCP registration: ${installation.changed ? "configured" : "already current"}`);
  console.log("Project /mcp trust: unknown until approved interactively in Claude Code");
  reportClaudeSkillInstallation(projectRoot);
  console.log(`Claude approval capability: ${describeClaudeCodeApprovalCapability(claudeVersion)}`);
  console.log(`DSH CLI: ${dshVersion}`);
  console.log(`DSH Host: ${hostUrl}`);
  console.log(`DSH preset: ${preset ?? "Host default"}`);

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
