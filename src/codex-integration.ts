import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { CallerCapabilities, CallerIntegration, InstallPlan, UpsertMcpServerOperation } from "./caller-integration.js";

export const CODEX_CALLER_ID = "codex";
export const CODEX_SERVER_NAME = "dsh_agentlink";
export const CODEX_LEGACY_SERVER_NAMES = ["dsh_collab"] as const;
export const CODEX_BRIDGE_SERVER_NAMES = [CODEX_SERVER_NAME, ...CODEX_LEGACY_SERVER_NAMES] as const;
export const CODEX_RESTART_HINT =
  "Restart Codex to load dsh-Agentlink. Configure the desired model in DSH; delegation will use that live route.";

const CODEX_CAPABILITIES: CallerCapabilities = {
  mcpStdio: true,
  configScopes: ["user", "explicit-file"],
  instructionInstall: "manual",
  humanApprovalPrompt: "supported",
  legacyMigration: true,
  restartRequired: true,
};

export interface RenderMcpConfigOptions {
  entryPath: string;
  nodePath: string;
  hostUrl: string;
  dshVersion?: string;
  preset?: string;
}

export interface CodexInstallPlanOptions extends RenderMcpConfigOptions {
  configPath: string;
  replace: boolean;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function renderCodexOperation(operation: UpsertMcpServerOperation): string {
  const env = Object.entries(operation.env).map(([name, value]) => `${name} = ${tomlString(value)}`);
  return [
    `[mcp_servers.${operation.serverName}]`,
    `command = ${tomlString(operation.command)}`,
    `args = [${operation.args.map((argument) => tomlString(argument)).join(", ")}]`,
    "",
    `[mcp_servers.${operation.serverName}.env]`,
    ...env,
    "",
    `[mcp_servers.${operation.serverName}.tools.${operation.humanApproval.toolName}]`,
    `approval_mode = ${tomlString(operation.humanApproval.mode === "human-prompt" ? "prompt" : operation.humanApproval.mode)}`,
  ].join("\n");
}

export function renderMcpConfig(options: RenderMcpConfigOptions): string {
  return renderCodexOperation(createCodexOperation({ ...options, replace: false }));
}

function tableHeader(line: string): { name: string; array: boolean } | undefined {
  const match = /^\s*(\[\[|\[)([^\[\]]+)(\]\]|\])\s*(?:#.*)?$/.exec(line);
  if (match === null) return undefined;
  const open = match[1];
  const name = match[2];
  const close = match[3];
  if (open === undefined || name === undefined || close === undefined) return undefined;
  const array = open === "[[";
  if ((array && close !== "]]") || (!array && close !== "]")) return undefined;
  return { name: name.replace(/\s+/g, ""), array };
}

function tableName(line: string): string | undefined {
  const header = tableHeader(line);
  return header?.array === false ? header.name : undefined;
}

function anyTableName(line: string): string | undefined {
  return tableHeader(line)?.name;
}

function isBridgeTable(name: string): boolean {
  const decoded = decodeDottedKey(name);
  if (decoded === undefined) return false;
  const joined = decoded.join(".");
  return CODEX_BRIDGE_SERVER_NAMES.some(
    (serverName) => joined === `mcp_servers.${serverName}` || joined.startsWith(`mcp_servers.${serverName}.`),
  );
}

const BASIC_KEY_ESCAPES: Record<string, string> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

function decodeBasicKeyContent(content: string): string | undefined {
  let decoded = "";
  let index = 0;
  while (index < content.length) {
    const char = content[index];
    if (char === undefined) return undefined;
    if (char !== "\\") {
      decoded += char;
      index += 1;
      continue;
    }
    const escape = content[index + 1];
    if (escape === undefined) return undefined;
    if (escape === "u" || escape === "U") {
      const hexLength = escape === "u" ? 4 : 8;
      const hex = content.slice(index + 2, index + 2 + hexLength);
      if (hex.length !== hexLength || !/^[0-9a-fA-F]+$/.test(hex)) return undefined;
      decoded += String.fromCodePoint(Number.parseInt(hex, 16));
      index += 2 + hexLength;
      continue;
    }
    const mapped = BASIC_KEY_ESCAPES[escape];
    if (mapped === undefined) return undefined;
    decoded += mapped;
    index += 2;
  }
  return decoded;
}

function splitKeySegments(keyText: string): string[] | undefined {
  const segments: string[] = [];
  let current = "";
  let index = 0;
  while (index < keyText.length) {
    const char = keyText[index];
    if (char === undefined) return undefined;
    if (char === '"' || char === "'") {
      const close = keyText.indexOf(char, index + 1);
      if (close === -1) return undefined;
      current += keyText.slice(index, close + 1);
      index = close + 1;
      continue;
    }
    if (char === ".") {
      segments.push(current);
      current = "";
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  segments.push(current);
  return segments;
}

function decodeKeySegment(segment: string): string | undefined {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return undefined;
  const quote = trimmed[0];
  if (quote === "'") {
    if (trimmed.length < 2 || !trimmed.endsWith("'")) return undefined;
    return trimmed.slice(1, -1);
  }
  if (quote === '"') {
    if (trimmed.length < 2 || !trimmed.endsWith('"')) return undefined;
    return decodeBasicKeyContent(trimmed.slice(1, -1));
  }
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

// Decodes a dotted TOML key ("a.b", a."b", "a\u005fb".c) into segments.
// Quoted dots stay inside their segment, matching TOML key semantics.
function decodeDottedKey(keyText: string): string[] | undefined {
  const rawSegments = splitKeySegments(keyText);
  if (rawSegments === undefined) return undefined;
  const decoded: string[] = [];
  for (const segment of rawSegments) {
    const value = decodeKeySegment(segment);
    if (value === undefined) return undefined;
    decoded.push(value);
  }
  return decoded;
}

// Extracts the decoded key segments of an `key = value` line without touching
// the value. Returns undefined for non-assignment lines and "unsupported" for
// assignments whose key we cannot parse safely (the caller must fail closed).
function assignmentKey(line: string): readonly string[] | "unsupported" | undefined {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("[")) return undefined;
  let index = 0;
  while (index < trimmed.length) {
    const char = trimmed[index];
    if (char === undefined) return undefined;
    if (char === '"' || char === "'") {
      const close = trimmed.indexOf(char, index + 1);
      if (close === -1) return "unsupported";
      index = close + 1;
      continue;
    }
    if (char === "=") break;
    index += 1;
  }
  if (index >= trimmed.length) return undefined;
  const decoded = decodeDottedKey(trimmed.slice(0, index));
  return decoded ?? "unsupported";
}

export function hasBridgeConfig(config: string): boolean {
  return config.split(/\r?\n/).some((line) => {
    const name = anyTableName(line);
    return name !== undefined && isBridgeTable(name);
  });
}

export function extractBridgeConfig(config: string): string | undefined {
  const collected: string[] = [];
  let collecting = false;
  let found = false;
  for (const line of config.split(/\r?\n/)) {
    const name = anyTableName(line);
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
  const unsupportedKeyError = () =>
    new Error(
      "Codex config contains a quoted or escaped TOML key that setup cannot parse safely; convert it to plain table form before running setup",
    );

  // Only root-scope assignments (before the first table header) can collide
  // with the appended root-level [mcp_servers.<name>] table. Assignments under
  // another table header define that table's keys and are harmless here.
  let inRootScope = true;
  let inMcpServersTable = false;
  for (const line of config.split(/\r?\n/)) {
    const header = tableHeader(line);
    if (header !== undefined) {
      inRootScope = false;
      const name = decodeDottedKey(header.name)?.join(".");
      if (name === undefined) throw unsupportedKeyError();
      if (header.array && isBridgeTable(name)) {
        throw new Error(
          "found an array-table dsh-Agentlink MCP configuration; remove or convert it to table form before running setup",
        );
      }
      if (CODEX_BRIDGE_SERVER_NAMES.some((serverName) => name.includes(serverName)) && !isBridgeTable(name)) {
        throw new Error(
          "found a non-standard dsh-Agentlink table; setup will not guess how to rewrite it. Use the manual configuration guide.",
        );
      }
      inMcpServersTable = !header.array && name === "mcp_servers";
      continue;
    }
    const key = assignmentKey(line);
    if (key === "unsupported") throw unsupportedKeyError();
    if (key === undefined) continue;
    if (inRootScope && key[0] === "mcp_servers") {
      // A root-level whole-inline-table assignment (mcp_servers = { ... }) cannot be
      // extended by the appended [mcp_servers.<name>] table — TOML forbids adding to
      // an inline table — so any such file would become invalid after an append,
      // with or without a bridge entry inside. A root-level dotted assignment for a
      // bridge server collides with the appended table just as directly.
      if (key.length === 1) {
        throw new Error(
          "found a root-level inline mcp_servers table; convert it to [mcp_servers.<name>] table form before running setup",
        );
      }
      if (CODEX_BRIDGE_SERVER_NAMES.some((serverName) => key[1] === serverName)) {
        throw new Error(
          "found an inline/dotted dsh-Agentlink MCP configuration; remove or convert it to table form before running setup",
        );
      }
    }
    if (inMcpServersTable && CODEX_BRIDGE_SERVER_NAMES.some((serverName) => key[0] === serverName)) {
      throw new Error(
        "found an inline dsh-Agentlink value under [mcp_servers]; remove or convert it to table form before running setup",
      );
    }
  }
}

function assertBasicTomlTableSyntax(config: string): void {
  const tableHeader = /^(?:\[[^\[\]]+\]|\[\[[^\[\]]+\]\])\s*(?:#.*)?$/;
  for (const line of config.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && !tableHeader.test(trimmed)) {
      throw new Error("Codex config contains an unsupported TOML table header; setup will not edit it automatically.");
    }
  }
}

export function upsertMcpConfig(config: string, bridgeBlock: string, replace: boolean): string {
  rejectUnsupportedInlineConfig(config);
  assertBasicTomlTableSyntax(config);
  const exists = hasBridgeConfig(config);
  if (exists && !replace) {
    throw new Error(
      `Codex MCP server ${CODEX_SERVER_NAME} or legacy ${CODEX_LEGACY_SERVER_NAMES.join(", ")} already exists; rerun with --replace after reviewing it`,
    );
  }

  const kept: string[] = [];
  let omit = false;
  for (const line of config.split(/\r?\n/)) {
    const name = anyTableName(line);
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

function buildEnv(options: RenderMcpConfigOptions): Record<string, string> {
  return {
    DSH_HOST_URL: options.hostUrl,
    ...(options.dshVersion === undefined ? {} : { DSH_HOST_VERSION: options.dshVersion }),
    ...(options.preset === undefined ? {} : { DSH_BRIDGE_AGENT_PRESET: options.preset }),
  };
}

function createCodexOperation(options: RenderMcpConfigOptions & { replace: boolean }): UpsertMcpServerOperation {
  return {
    kind: "upsert-mcp-server",
    serverName: CODEX_SERVER_NAME,
    legacyServerNames: CODEX_LEGACY_SERVER_NAMES,
    command: options.nodePath,
    args: [options.entryPath],
    env: buildEnv(options),
    humanApproval: {
      toolName: "dsh_resolve_approval",
      mode: "human-prompt",
    },
    replace: options.replace,
  };
}

export function createCodexInstallPlan(options: CodexInstallPlanOptions): InstallPlan {
  const operation = createCodexOperation(options);
  const targetDescription = "Codex MCP TOML config file";
  return {
    callerId: CODEX_CALLER_ID,
    callerName: "Codex",
    capabilities: CODEX_CAPABILITIES,
    target: {
      path: options.configPath,
      format: "toml",
      scope: options.configPath === defaultCodexConfigPath() ? "user" : "explicit-file",
    },
    targetDescription,
    operations: [operation],
    verification: [{ kind: "mcp-server-block-matches", serverName: CODEX_SERVER_NAME }],
    warnings: [
      `Existing ${CODEX_SERVER_NAME} or legacy ${CODEX_LEGACY_SERVER_NAMES.join(", ")} entries require explicit replacement approval.`,
      CODEX_RESTART_HINT,
    ],
    restartHint: CODEX_RESTART_HINT,
  };
}

export function verifyCodexMcpBlock(content: string, bridgeBlock: string): boolean {
  try {
    rejectUnsupportedInlineConfig(content);
    assertBasicTomlTableSyntax(content);
  } catch {
    return false;
  }
  return extractBridgeConfig(content) === bridgeBlock.trim();
}

export function verifyCodexMcpConfig(content: string, operation: UpsertMcpServerOperation): boolean {
  return verifyCodexMcpBlock(content, renderCodexOperation(operation));
}

export const codexIntegration: CallerIntegration<CodexInstallPlanOptions> = {
  id: CODEX_CALLER_ID,
  name: "Codex",
  capabilities: CODEX_CAPABILITIES,
  defaultConfigPath(context) {
    return defaultCodexConfigPath(context.env);
  },
  createInstallPlan: createCodexInstallPlan,
  verifyInstalled(content, operation) {
    if (operation.kind !== "upsert-mcp-server") return false;
    return verifyCodexMcpConfig(content, operation);
  },
};
