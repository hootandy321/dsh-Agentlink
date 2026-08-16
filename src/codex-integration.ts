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
  return CODEX_BRIDGE_SERVER_NAMES.some(
    (serverName) =>
      name === `mcp_servers.${serverName}` ||
      name.startsWith(`mcp_servers.${serverName}.`) ||
      name === `mcp_servers."${serverName}"` ||
      name.startsWith(`mcp_servers."${serverName}".`),
  );
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
  const serverNamePattern = `(?:${CODEX_BRIDGE_SERVER_NAMES.flatMap((name) => [name, `"${name}"`]).join("|")})`;
  const dottedAssignment = new RegExp(`^\\s*mcp_servers\\s*\\.\\s*${serverNamePattern}\\s*\\.`, "m");
  if (dottedAssignment.test(config)) {
    throw new Error(
      "found an inline/dotted dsh-Agentlink MCP configuration; remove or convert it to table form before running setup",
    );
  }

  const lines = config.split(/\r?\n/);
  let inMcpServersTable = false;
  for (const line of lines) {
    const header = tableHeader(line);
    const name = header?.name;
    if (header !== undefined && header.array && isBridgeTable(header.name)) {
      throw new Error(
        "found an array-table dsh-Agentlink MCP configuration; remove or convert it to table form before running setup",
      );
    }
    if (name !== undefined && CODEX_BRIDGE_SERVER_NAMES.some((serverName) => name.includes(serverName)) && !isBridgeTable(name)) {
      throw new Error(
        "found a non-standard dsh-Agentlink table; setup will not guess how to rewrite it. Use the manual configuration guide.",
      );
    }
    if (header !== undefined) inMcpServersTable = !header.array && header.name === "mcp_servers";
    else if (inMcpServersTable && new RegExp(`^\\s*${serverNamePattern}\\s*=`).test(line)) {
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

export function verifyCodexMcpConfig(content: string, operation: UpsertMcpServerOperation): boolean {
  try {
    rejectUnsupportedInlineConfig(content);
    assertBasicTomlTableSyntax(content);
  } catch {
    return false;
  }
  return extractBridgeConfig(content) === renderCodexOperation(operation).trim();
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
