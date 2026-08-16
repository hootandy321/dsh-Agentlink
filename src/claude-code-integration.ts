import { isAbsolute, join } from "node:path";

import type {
  CallerCapabilities,
  CallerIntegration,
  InstallInstructionsOperation,
  InstallPlan,
  InstallOperation,
  UpsertMcpServerOperation,
} from "./caller-integration.js";

export const CLAUDE_CODE_CALLER_ID = "claude-code";
export const CLAUDE_CODE_SERVER_NAME = "dsh_agentlink";
export const CLAUDE_CODE_LEGACY_SERVER_NAMES = ["dsh_collab"] as const;
export const CLAUDE_CODE_BRIDGE_SERVER_NAMES = [CLAUDE_CODE_SERVER_NAME, ...CLAUDE_CODE_LEGACY_SERVER_NAMES] as const;
export const CLAUDE_CODE_RESTART_HINT =
  "Reload or restart Claude Code, then use /mcp to approve the project MCP server interactively. MCP registration does not prove that the DSH Web Host is reachable.";

const CLAUDE_CODE_CAPABILITIES: CallerCapabilities = {
  mcpStdio: true,
  configScopes: ["project"],
  instructionInstall: "native",
  humanApprovalPrompt: "supported",
  legacyMigration: true,
  restartRequired: true,
};

export interface ClaudeCodeInstallPlanOptions {
  cwd: string;
  entryPath: string;
  nodePath: string;
  hostUrl: string;
  dshVersion?: string;
  preset?: string;
  replace: boolean;
  installSkill?: boolean;
  replaceSkill?: boolean;
  skillSourcePath?: string;
  skillContent?: string;
}

interface ClaudeCodeMcpServerConfig {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

type JsonObject = Record<string, unknown>;

function isPlainJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJsonNumbersArePreservable(value: unknown): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error(
        "Claude Code .mcp.json contains a number that JavaScript cannot preserve exactly; setup will not rewrite the file.",
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonNumbersArePreservable(item);
    return;
  }
  if (isPlainJsonObject(value)) {
    for (const item of Object.values(value)) assertJsonNumbersArePreservable(item);
  }
}

function parseClaudeCodeConfig(content: string): JsonObject {
  if (content.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Claude Code .mcp.json must be strict JSON; setup will not edit invalid JSON.");
  }
  if (!isPlainJsonObject(parsed)) {
    throw new Error("Claude Code .mcp.json root must be a JSON object.");
  }
  assertJsonNumbersArePreservable(parsed);
  const mcpServers = parsed.mcpServers;
  if (mcpServers !== undefined && !isPlainJsonObject(mcpServers)) {
    throw new Error("Claude Code .mcp.json mcpServers must be a JSON object when present.");
  }
  return parsed;
}

function cloneConfig(config: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(config)) as JsonObject;
}

function buildEnv(options: Pick<ClaudeCodeInstallPlanOptions, "hostUrl" | "dshVersion" | "preset">): Record<string, string> {
  return {
    DSH_HOST_URL: options.hostUrl,
    ...(options.dshVersion === undefined ? {} : { DSH_HOST_VERSION: options.dshVersion }),
    ...(options.preset === undefined ? {} : { DSH_BRIDGE_AGENT_PRESET: options.preset }),
  };
}

function assertNonEmptyString(value: string, label: string): void {
  if (value.trim() === "") throw new Error(`${label} must be a non-empty string.`);
}

function assertAbsolutePath(value: string, label: string): void {
  assertNonEmptyString(value, label);
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
}

function assertClaudeCodeOperation(operation: UpsertMcpServerOperation): void {
  if (operation.kind !== "upsert-mcp-server") throw new Error("Claude Code install plan is missing an MCP server operation.");
  if (operation.serverName !== CLAUDE_CODE_SERVER_NAME) {
    throw new Error(`Claude Code MCP server name must be ${CLAUDE_CODE_SERVER_NAME}.`);
  }
  assertAbsolutePath(operation.command, "Claude Code MCP command");
  if (operation.args.length === 0) throw new Error("Claude Code MCP args must include the server entry path.");
  operation.args.forEach((argument, index) => assertNonEmptyString(argument, `Claude Code MCP arg ${index}`));
  assertAbsolutePath(operation.args[0] as string, "Claude Code MCP entry path");
}

function assertClaudeCodeSkillOperation(operation: InstallInstructionsOperation): void {
  assertAbsolutePath(operation.sourcePath, "Claude Code skill source path");
  assertAbsolutePath(operation.targetPath, "Claude Code skill target path");
  assertNonEmptyString(operation.content, "Claude Code skill content");
  if (operation.conflictPolicy !== "fail" && operation.conflictPolicy !== "replace-explicitly") {
    throw new Error("Claude Code skill conflict policy must be fail or replace-explicitly.");
  }
}

export function defaultClaudeCodeConfigPath(cwd: string): string {
  assertAbsolutePath(cwd, "Claude Code project directory");
  return join(cwd, ".mcp.json");
}

function createClaudeCodeOperation(options: ClaudeCodeInstallPlanOptions): UpsertMcpServerOperation {
  return {
    kind: "upsert-mcp-server",
    serverName: CLAUDE_CODE_SERVER_NAME,
    legacyServerNames: CLAUDE_CODE_LEGACY_SERVER_NAMES,
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

export function createClaudeCodeInstallPlan(options: ClaudeCodeInstallPlanOptions): InstallPlan {
  const operation = createClaudeCodeOperation(options);
  assertClaudeCodeOperation(operation);
  const targetPath = defaultClaudeCodeConfigPath(options.cwd);
  const operations: InstallOperation[] = [operation];
  if (options.installSkill === true) {
    if (options.skillSourcePath === undefined || options.skillContent === undefined) {
      throw new Error("Claude Code skill installation requires skillSourcePath and skillContent.");
    }
    const skillOperation: InstallInstructionsOperation = {
      kind: "install-instructions",
      sourcePath: options.skillSourcePath,
      targetPath: join(options.cwd, ".claude", "skills", "claude-code-dsh", "SKILL.md"),
      content: options.skillContent,
      conflictPolicy: options.replaceSkill === true ? "replace-explicitly" : "fail",
    };
    assertClaudeCodeSkillOperation(skillOperation);
    operations.push(skillOperation);
  }
  return {
    callerId: CLAUDE_CODE_CALLER_ID,
    callerName: "Claude Code",
    capabilities: CLAUDE_CODE_CAPABILITIES,
    target: {
      path: targetPath,
      format: "json",
      scope: "project",
    },
    targetDescription: "Claude Code project .mcp.json file",
    operations,
    verification: [{ kind: "mcp-server-block-matches", serverName: CLAUDE_CODE_SERVER_NAME }],
    warnings: [
      `Existing ${CLAUDE_CODE_SERVER_NAME} or legacy ${CLAUDE_CODE_LEGACY_SERVER_NAMES.join(", ")} entries require explicit replacement approval unless the canonical entry is already equivalent.`,
      CLAUDE_CODE_RESTART_HINT,
    ],
    restartHint: CLAUDE_CODE_RESTART_HINT,
  };
}

export function renderClaudeCodeOperation(operation: UpsertMcpServerOperation): ClaudeCodeMcpServerConfig {
  assertClaudeCodeOperation(operation);
  return {
    type: "stdio",
    command: operation.command,
    args: [...operation.args],
    env: { ...operation.env },
  };
}

function equivalentMcpServerConfig(left: unknown, right: ClaudeCodeMcpServerConfig): boolean {
  if (!isPlainJsonObject(left)) return false;
  const leftKeys = Object.keys(left).sort();
  if (JSON.stringify(leftKeys) !== JSON.stringify(["args", "command", "env", "type"])) return false;
  if (left.type !== right.type || left.command !== right.command) return false;
  if (!Array.isArray(left.args) || left.args.length !== right.args.length) return false;
  if (left.args.some((argument, index) => argument !== right.args[index])) return false;
  if (!isPlainJsonObject(left.env)) return false;
  const leftEnv = left.env;
  const leftEnvEntries = Object.entries(leftEnv);
  const rightEnvEntries = Object.entries(right.env);
  if (leftEnvEntries.length !== rightEnvEntries.length) return false;
  return rightEnvEntries.every(([name, value]) => leftEnv[name] === value);
}

function bridgeServerNames(operation: UpsertMcpServerOperation): readonly string[] {
  return [operation.serverName, ...operation.legacyServerNames];
}

export function verifyClaudeCodeMcpConfig(content: string, operation: UpsertMcpServerOperation): boolean {
  try {
    const config = parseClaudeCodeConfig(content);
    const mcpServers = config.mcpServers;
    if (!isPlainJsonObject(mcpServers)) return false;
    for (const legacyName of operation.legacyServerNames) {
      if (Object.hasOwn(mcpServers, legacyName)) return false;
    }
    return equivalentMcpServerConfig(mcpServers[operation.serverName], renderClaudeCodeOperation(operation));
  } catch {
    return false;
  }
}

export function upsertClaudeCodeMcpConfig(content: string, operation: UpsertMcpServerOperation): string {
  const config = parseClaudeCodeConfig(content);
  const rendered = renderClaudeCodeOperation(operation);
  const mcpServers = config.mcpServers === undefined ? {} : config.mcpServers;
  if (!isPlainJsonObject(mcpServers)) throw new Error("Claude Code .mcp.json mcpServers must be a JSON object when present.");

  const existingNames = bridgeServerNames(operation).filter((name) => Object.hasOwn(mcpServers, name));
  const canonicalOnlyEquivalent =
    existingNames.length === 1 &&
    existingNames[0] === operation.serverName &&
    equivalentMcpServerConfig(mcpServers[operation.serverName], rendered);
  if (canonicalOnlyEquivalent) return content;
  if (existingNames.length > 0 && !operation.replace) {
    throw new Error(
      `Claude Code MCP server ${operation.serverName} or legacy ${operation.legacyServerNames.join(", ")} already exists; rerun with --replace after reviewing it`,
    );
  }

  const updated = cloneConfig(config);
  const updatedMcpServers = isPlainJsonObject(updated.mcpServers) ? { ...updated.mcpServers } : {};
  for (const name of bridgeServerNames(operation)) delete updatedMcpServers[name];
  updatedMcpServers[operation.serverName] = rendered;
  updated.mcpServers = updatedMcpServers;
  return `${JSON.stringify(updated, null, 2)}\n`;
}

export const claudeCodeIntegration: CallerIntegration<ClaudeCodeInstallPlanOptions> = {
  id: CLAUDE_CODE_CALLER_ID,
  name: "Claude Code",
  capabilities: CLAUDE_CODE_CAPABILITIES,
  defaultConfigPath(context) {
    return defaultClaudeCodeConfigPath(context.cwd);
  },
  createInstallPlan: createClaudeCodeInstallPlan,
  verifyInstalled(content, operation) {
    if (operation.kind !== "upsert-mcp-server") return false;
    return verifyClaudeCodeMcpConfig(content, operation);
  },
};
