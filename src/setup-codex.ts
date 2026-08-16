#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CODEX_LEGACY_SERVER_NAMES,
  CODEX_RESTART_HINT,
  CODEX_SERVER_NAME,
  codexIntegration,
  extractBridgeConfig,
  hasBridgeConfig,
  renderCodexOperation,
  upsertMcpConfig,
} from "./codex-integration.js";
import type { InstallPlan, UpsertMcpServerOperation } from "./caller-integration.js";
import { loadConfig } from "./config.js";
import { DshClient } from "./dsh-client.js";
import { probeDshCliVersion, runDoctor } from "./doctor.js";
import { atomicInstallText, readConfigSnapshot } from "./setup-engine.js";
import type { ConfigSnapshot } from "./setup-engine.js";

const DEFAULT_HOST_URL = "http://127.0.0.1:3080";
const DEFAULT_PRESET = "code";

export {
  CODEX_LEGACY_SERVER_NAMES as LEGACY_SERVER_NAMES,
  CODEX_SERVER_NAME as SERVER_NAME,
  codexIntegration,
  createCodexInstallPlan,
  defaultCodexConfigPath,
  extractBridgeConfig,
  hasBridgeConfig,
  renderCodexOperation,
  renderMcpConfig,
  upsertMcpConfig,
  verifyCodexMcpConfig,
} from "./codex-integration.js";
export { readConfigSnapshot } from "./setup-engine.js";
export type { ConfigSnapshot } from "./setup-engine.js";
export type { RenderMcpConfigOptions } from "./codex-integration.js";

export interface SetupOptions {
  yes: boolean;
  replace: boolean;
  dryRun: boolean;
  skipDoctor: boolean;
  noPreset: boolean;
  help: boolean;
  host?: string;
  preset?: string;
  configPath?: string;
}

function valueAfter(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export function parseSetupArgs(argv: string[]): SetupOptions {
  const options: SetupOptions = {
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
    else if (argument === "--config") {
      options.configPath = valueAfter(argv, index, argument);
      index += 1;
    } else if (argument?.startsWith("--config=")) options.configPath = argument.slice("--config=".length);
    else throw new Error(`unknown option: ${argument}`);
  }

  if (options.noPreset && options.preset !== undefined) {
    throw new Error("--preset and --no-preset cannot be used together");
  }
  return options;
}

export interface InstallMcpConfigResult {
  changed: boolean;
  backupPath?: string;
}

export async function installMcpConfigFile(
  path: string,
  bridgeBlock: string,
  replace: boolean,
  expected?: ConfigSnapshot,
): Promise<InstallMcpConfigResult> {
  const snapshot = expected ?? (await readConfigSnapshot(path));
  if (extractBridgeConfig(snapshot.content) === bridgeBlock.trim()) return { changed: false };

  const updated = upsertMcpConfig(snapshot.content, bridgeBlock, replace);
  const result = await atomicInstallText({
    path,
    content: updated,
    expected: snapshot,
    backupLabel: "dsh-agentlink",
    tempLabel: "dsh-agentlink",
    verify: (content) => extractBridgeConfig(content) === bridgeBlock.trim(),
  });
  return result;
}

function firstCodexOperation(plan: InstallPlan): UpsertMcpServerOperation {
  const operation = plan.operations[0];
  if (operation?.kind !== "upsert-mcp-server") throw new Error("Codex install plan is missing an MCP server operation");
  return operation;
}

export async function installCodexPlan(plan: InstallPlan, expected?: ConfigSnapshot): Promise<InstallMcpConfigResult> {
  const operation = firstCodexOperation(plan);
  const bridgeBlock = renderCodexOperation(operation);
  const snapshot = expected ?? (await readConfigSnapshot(plan.target.path));
  if (extractBridgeConfig(snapshot.content) === bridgeBlock.trim()) return { changed: false };

  const updated = upsertMcpConfig(snapshot.content, bridgeBlock, operation.replace);
  const result = await atomicInstallText({
    path: plan.target.path,
    content: updated,
    expected: snapshot,
    backupLabel: "dsh-agentlink",
    tempLabel: "dsh-agentlink",
    verify: (content) => codexIntegration.verifyInstalled(content, operation),
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
  console.log(`dsh-Agentlink Codex setup

Usage:
  npm run setup
  npm run setup -- --yes

Options:
  --host <url>       DSH Web Host origin (default: ${DEFAULT_HOST_URL})
  --preset <name>    DSH agent preset (default: ${DEFAULT_PRESET})
  --no-preset        Follow DSH's own default preset
  --replace          Replace an existing ${CODEX_SERVER_NAME} configuration
  --config <path>    Write a specific Codex config file
  --dry-run          Print the generated block without writing
  --skip-doctor      Skip the read-only DSH Host check
  --yes, -y          Use defaults without interactive questions
  --help, -h         Show this help`);
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
  const configPath = resolve(options.configPath ?? codexIntegration.defaultConfigPath({ cwd: process.cwd(), env: process.env }));
  const entryPath = await realpath(fileURLToPath(new URL("./index.js", import.meta.url)));

  let plan = codexIntegration.createInstallPlan({
    configPath,
    entryPath,
    nodePath: process.execPath,
    hostUrl,
    dshVersion,
    replace: options.replace,
    ...(preset === undefined ? {} : { preset }),
  });
  let operation = firstCodexOperation(plan);
  let bridgeBlock = renderCodexOperation(operation);

  const snapshot = await readConfigSnapshot(configPath);
  const existing = snapshot.content;
  if (extractBridgeConfig(existing) === bridgeBlock.trim()) {
    console.log(`${CODEX_SERVER_NAME} already matches this setup. No changes made.`);
    return;
  }

  let replace = options.replace;
  if (hasBridgeConfig(existing) && !replace) {
    if (options.yes) {
      throw new Error(
        `${CODEX_SERVER_NAME} or legacy ${CODEX_LEGACY_SERVER_NAMES.join(", ")} already exists; inspect it and rerun with --replace to update it`,
      );
    }
    replace = await askYesNo(
      `Replace the existing ${CODEX_SERVER_NAME} or legacy ${CODEX_LEGACY_SERVER_NAMES.join(", ")} configuration?`,
    );
    if (!replace) {
      console.log("No changes made.");
      return;
    }
  }
  if (operation.replace !== replace) {
    plan = codexIntegration.createInstallPlan({
      configPath,
      entryPath,
      nodePath: process.execPath,
      hostUrl,
      dshVersion,
      replace,
      ...(preset === undefined ? {} : { preset }),
    });
    operation = firstCodexOperation(plan);
    bridgeBlock = renderCodexOperation(operation);
  }

  if (options.dryRun) {
    upsertMcpConfig(existing, bridgeBlock, replace);
    console.log(`# Would update ${plan.target.path}\n\n${bridgeBlock}`);
    return;
  }

  const installation = await installCodexPlan(plan, snapshot);
  if (!installation.changed) {
    console.log(`${CODEX_SERVER_NAME} already matches this setup. No changes made.`);
    return;
  }

  console.log(`Configured ${CODEX_SERVER_NAME} in ${configPath}`);
  if (installation.backupPath !== undefined) console.log(`Backup: ${installation.backupPath}`);
  console.log(`DSH CLI: ${dshVersion}`);
  console.log(`DSH Host: ${hostUrl}`);
  console.log(`DSH preset: ${preset ?? "Host default"}`);
  console.log("Approval policy: prompt (allow_once remains human-gated)");

  if (!options.skipDoctor) {
    const config = loadConfig({
      DSH_HOST_URL: hostUrl,
      DSH_HOST_VERSION: dshVersion,
      DSH_BRIDGE_TIME_ZONE: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(preset === undefined ? {} : { DSH_BRIDGE_AGENT_PRESET: preset }),
    });
    const report = await runDoctor(config, new DshClient(config.hostUrl, config.requestTimeoutMs), async () => dshVersion);
    if (report.ok) console.log(`Host check: ${report.compatibility}`);
    else console.log(`Host check: not connected; start it with ${report.startCommand}`);
  }

  console.log(CODEX_RESTART_HINT);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error) => {
    console.error(`Setup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
