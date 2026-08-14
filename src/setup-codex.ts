#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadConfig } from "./config.js";
import { DshClient } from "./dsh-client.js";
import { probeDshCliVersion, runDoctor } from "./doctor.js";

const SERVER_NAME = "dsh_agentlink";
const LEGACY_SERVER_NAMES = ["dsh_collab"] as const;
const BRIDGE_SERVER_NAMES = [SERVER_NAME, ...LEGACY_SERVER_NAMES] as const;
const DEFAULT_HOST_URL = "http://127.0.0.1:3080";
const DEFAULT_PRESET = "code";

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

export interface RenderMcpConfigOptions {
  entryPath: string;
  nodePath: string;
  hostUrl: string;
  dshVersion?: string;
  preset?: string;
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

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function renderMcpConfig(options: RenderMcpConfigOptions): string {
  const env = [`DSH_HOST_URL = ${tomlString(options.hostUrl)}`];
  if (options.dshVersion !== undefined) env.push(`DSH_HOST_VERSION = ${tomlString(options.dshVersion)}`);
  if (options.preset !== undefined) env.push(`DSH_BRIDGE_AGENT_PRESET = ${tomlString(options.preset)}`);

  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(options.nodePath)}`,
    `args = [${tomlString(options.entryPath)}]`,
    "",
    `[mcp_servers.${SERVER_NAME}.env]`,
    ...env,
    "",
    `[mcp_servers.${SERVER_NAME}.tools.dsh_resolve_approval]`,
    `approval_mode = "prompt"`,
  ].join("\n");
}

function tableName(line: string): string | undefined {
  const match = /^\s*\[([^\[\]]+)]\s*(?:#.*)?$/.exec(line);
  return match?.[1]?.replace(/\s+/g, "");
}

function isBridgeTable(name: string): boolean {
  return BRIDGE_SERVER_NAMES.some(
    (serverName) =>
      name === `mcp_servers.${serverName}` ||
      name.startsWith(`mcp_servers.${serverName}.`) ||
      name === `mcp_servers."${serverName}"` ||
      name.startsWith(`mcp_servers."${serverName}".`),
  );
}

export function hasBridgeConfig(config: string): boolean {
  return config.split(/\r?\n/).some((line) => {
    const name = tableName(line);
    return name !== undefined && isBridgeTable(name);
  });
}

export function extractBridgeConfig(config: string): string | undefined {
  const collected: string[] = [];
  let collecting = false;
  let found = false;
  for (const line of config.split(/\r?\n/)) {
    const name = tableName(line);
    if (name !== undefined) collecting = isBridgeTable(name);
    if (collecting) {
      found = true;
      collected.push(line);
    }
  }
  return found ? collected.join("\n").trim() : undefined;
}

function rejectUnsupportedInlineConfig(config: string): void {
  if (config.includes('"""') || config.includes("'''")) {
    throw new Error(
      "Codex config contains a multiline TOML string; setup will not edit it automatically. Use the manual configuration guide.",
    );
  }
  const serverNamePattern = `(?:${BRIDGE_SERVER_NAMES.flatMap((name) => [name, `"${name}"`]).join("|")})`;
  const dottedAssignment = new RegExp(`^\\s*mcp_servers\\s*\\.\\s*${serverNamePattern}\\s*\\.`, "m");
  if (dottedAssignment.test(config)) {
    throw new Error(
      "found an inline/dotted dsh-Agentlink MCP configuration; remove or convert it to table form before running setup",
    );
  }

  const lines = config.split(/\r?\n/);
  let inMcpServersTable = false;
  for (const line of lines) {
    const name = tableName(line);
    if (name !== undefined && BRIDGE_SERVER_NAMES.some((serverName) => name.includes(serverName)) && !isBridgeTable(name)) {
      throw new Error(
        "found a non-standard dsh-Agentlink table; setup will not guess how to rewrite it. Use the manual configuration guide.",
      );
    }
    if (name !== undefined) inMcpServersTable = name === "mcp_servers";
    else if (inMcpServersTable && new RegExp(`^\\s*${serverNamePattern}\\s*=`).test(line)) {
      throw new Error(
        "found an inline dsh-Agentlink value under [mcp_servers]; remove or convert it to table form before running setup",
      );
    }
  }
}

export function upsertMcpConfig(config: string, bridgeBlock: string, replace: boolean): string {
  rejectUnsupportedInlineConfig(config);
  const exists = hasBridgeConfig(config);
  if (exists && !replace) {
    throw new Error(
      `Codex MCP server ${SERVER_NAME} or legacy ${LEGACY_SERVER_NAMES.join(", ")} already exists; rerun with --replace after reviewing it`,
    );
  }

  const kept: string[] = [];
  let omit = false;
  for (const line of config.split(/\r?\n/)) {
    const name = tableName(line);
    if (name !== undefined) omit = isBridgeTable(name);
    if (!omit) kept.push(line);
  }

  const prefix = kept.join("\n").trimEnd();
  return `${prefix === "" ? "" : `${prefix}\n\n`}${bridgeBlock.trim()}\n`;
}

export function defaultCodexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configuredRoot = env.CODEX_HOME?.trim();
  return join(configuredRoot === undefined || configuredRoot === "" ? join(homedir(), ".codex") : resolve(configuredRoot), "config.toml");
}

export interface ConfigSnapshot {
  content: string;
  exists: boolean;
  mode: number;
}

export async function readConfigSnapshot(path: string): Promise<ConfigSnapshot> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink()) {
      throw new Error(`refusing to replace symlinked Codex config: ${path}`);
    }
    if (!details.isFile()) throw new Error(`Codex config is not a regular file: ${path}`);
    return { content: await readFile(path, "utf8"), exists: true, mode: details.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: "", exists: false, mode: 0o600 };
    throw error;
  }
}

async function backupConfig(path: string, snapshot: ConfigSnapshot): Promise<string | undefined> {
  if (!snapshot.exists) return undefined;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${path}.bak-dsh-agentlink-${timestamp}-${process.pid}-${randomUUID()}`;
  await copyFile(path, backupPath, fsConstants.COPYFILE_EXCL);
  await chmod(backupPath, snapshot.mode);
  return backupPath;
}

async function atomicWrite(path: string, content: string, expected: ConfigSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(dirname(path), `.config.toml.dsh-agentlink-${process.pid}-${Date.now()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", expected.mode);
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, expected.mode);

    const latest = await readConfigSnapshot(path);
    if (latest.exists !== expected.exists || latest.content !== expected.content || latest.mode !== expected.mode) {
      throw new Error("Codex config changed during setup; no replacement was made. Rerun setup after reviewing it.");
    }
    await rename(temporaryPath, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
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
  const snapshot = await readConfigSnapshot(path);
  if (
    expected !== undefined &&
    (snapshot.exists !== expected.exists || snapshot.content !== expected.content || snapshot.mode !== expected.mode)
  ) {
    throw new Error("Codex config changed during setup; no replacement was made. Rerun setup after reviewing it.");
  }
  if (extractBridgeConfig(snapshot.content) === bridgeBlock.trim()) return { changed: false };

  const updated = upsertMcpConfig(snapshot.content, bridgeBlock, replace);
  const backupPath = await backupConfig(path, snapshot);
  await atomicWrite(path, updated, snapshot);
  return { changed: true, ...(backupPath === undefined ? {} : { backupPath }) };
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
  --replace          Replace an existing ${SERVER_NAME} configuration
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
  const configPath = resolve(options.configPath ?? defaultCodexConfigPath());
  const entryPath = await realpath(fileURLToPath(new URL("./index.js", import.meta.url)));

  const bridgeBlock = renderMcpConfig({
    entryPath,
    nodePath: process.execPath,
    hostUrl,
    dshVersion,
    ...(preset === undefined ? {} : { preset }),
  });

  const snapshot = await readConfigSnapshot(configPath);
  const existing = snapshot.content;
  if (extractBridgeConfig(existing) === bridgeBlock.trim()) {
    console.log(`${SERVER_NAME} already matches this setup. No changes made.`);
    return;
  }

  let replace = options.replace;
  if (hasBridgeConfig(existing) && !replace) {
    if (options.yes) {
      throw new Error(
        `${SERVER_NAME} or legacy ${LEGACY_SERVER_NAMES.join(", ")} already exists; inspect it and rerun with --replace to update it`,
      );
    }
    replace = await askYesNo(
      `Replace the existing ${SERVER_NAME} or legacy ${LEGACY_SERVER_NAMES.join(", ")} configuration?`,
    );
    if (!replace) {
      console.log("No changes made.");
      return;
    }
  }

  if (options.dryRun) {
    upsertMcpConfig(existing, bridgeBlock, replace);
    console.log(`# Would update ${configPath}\n\n${bridgeBlock}`);
    return;
  }

  const installation = await installMcpConfigFile(configPath, bridgeBlock, replace, snapshot);
  if (!installation.changed) {
    console.log(`${SERVER_NAME} already matches this setup. No changes made.`);
    return;
  }

  console.log(`Configured ${SERVER_NAME} in ${configPath}`);
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

  console.log("Restart Codex to load dsh-Agentlink. Configure the desired model in DSH; delegation will use that live route.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error) => {
    console.error(`Setup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
