export type CallerIntegrationId = "codex" | "claude-code";

export type ConfigScope = "user" | "project" | "local" | "explicit-file";

export type ConfigFormat = "toml" | "json";

export type InstructionInstallMode = "native" | "generated" | "manual";

export type HumanApprovalPromptSupport = "supported" | "manual" | "unsupported";

export interface CallerConfigContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface CallerCapabilities {
  mcpStdio: boolean;
  configScopes: readonly ConfigScope[];
  instructionInstall: InstructionInstallMode;
  humanApprovalPrompt: HumanApprovalPromptSupport;
  legacyMigration: boolean;
  restartRequired: boolean;
}

export interface InstallTarget {
  path: string;
  format: ConfigFormat;
  scope: ConfigScope;
}

export interface UpsertMcpServerOperation {
  kind: "upsert-mcp-server";
  serverName: string;
  legacyServerNames: readonly string[];
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  humanApproval: {
    toolName: string;
    mode: "human-prompt";
  };
  replace: boolean;
}

export interface InstallInstructionsOperation {
  kind: "install-instructions";
  sourcePath: string;
  targetPath: string;
  content: string;
  conflictPolicy: "fail" | "replace-explicitly";
}

export type InstallOperation = UpsertMcpServerOperation | InstallInstructionsOperation;

export interface VerificationDescriptor {
  kind: "mcp-server-block-matches";
  serverName: string;
}

export interface InstallPlan {
  callerId: CallerIntegrationId;
  callerName: string;
  capabilities: CallerCapabilities;
  target: InstallTarget;
  targetDescription: string;
  operations: readonly InstallOperation[];
  verification: readonly VerificationDescriptor[];
  warnings: readonly string[];
  restartHint: string;
}

export interface CallerIntegration<Options> {
  readonly id: CallerIntegrationId;
  readonly name: string;
  readonly capabilities: CallerCapabilities;
  defaultConfigPath(context: CallerConfigContext): string;
  createInstallPlan(options: Options): InstallPlan;
  verifyInstalled(content: string, operation: InstallOperation): boolean;
}
