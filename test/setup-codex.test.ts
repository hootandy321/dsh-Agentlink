import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  codexIntegration,
  createCodexInstallPlan,
  defaultCodexConfigPath,
  extractBridgeConfig,
  hasBridgeConfig,
  installMcpConfigFile,
  installCodexPlan,
  parseSetupArgs,
  readConfigSnapshot,
  renderCodexOperation,
  renderMcpConfig,
  upsertMcpConfig,
  verifyCodexMcpConfig,
} from "../src/setup-codex.js";

const block = renderMcpConfig({
  nodePath: "/Applications/Node Runtime/bin/node",
  entryPath: "/tmp/dsh Agentlink/dist/index.js",
  hostUrl: "http://127.0.0.1:3080",
  dshVersion: "0.1.0-rc.6",
  preset: "code",
});

test("setup renders one safe stdio MCP block with human-gated approval", () => {
  assert.match(block, /command = "\/Applications\/Node Runtime\/bin\/node"/);
  assert.match(block, /args = \["\/tmp\/dsh Agentlink\/dist\/index.js"\]/);
  assert.match(block, /DSH_HOST_URL = "http:\/\/127\.0\.0\.1:3080"/);
  assert.match(block, /DSH_HOST_VERSION = "0\.1\.0-rc\.6"/);
  assert.match(block, /DSH_BRIDGE_AGENT_PRESET = "code"/);
  assert.match(block, /\[mcp_servers\.dsh_agentlink\.tools\.dsh_resolve_approval]/);
  assert.match(block, /approval_mode = "prompt"/);
  assert.equal(block.includes("tool_timeout_sec"), false);
});

test("setup exposes a caller integration install plan without original config content", () => {
  const secret = "existing-secret-value";
  const existingConfig = `model = "private"\ntoken = "${secret}"\n`;
  const plan = createCodexInstallPlan({
    configPath: "/tmp/codex/config.toml",
    nodePath: "/usr/local/bin/node",
    entryPath: "/tmp/dsh-Agentlink/dist/index.js",
    hostUrl: "http://127.0.0.1:3080",
    dshVersion: "0.1.0-rc.7",
    preset: "code",
    replace: true,
  });
  const operation = plan.operations[0];
  assert.equal(operation?.kind, "upsert-mcp-server");
  const rendered = renderCodexOperation(operation);
  const serialized = JSON.stringify(plan);

  assert.equal(plan.callerId, "codex");
  assert.equal(plan.callerName, "Codex");
  assert.deepEqual(plan.capabilities, {
    mcpStdio: true,
    configScopes: ["user", "explicit-file"],
    instructionInstall: "manual",
    humanApprovalPrompt: "supported",
    legacyMigration: true,
    restartRequired: true,
  });
  assert.deepEqual(plan.target, {
    path: "/tmp/codex/config.toml",
    format: "toml",
    scope: "explicit-file",
  });
  assert.equal(plan.targetDescription, "Codex MCP TOML config file");
  assert.deepEqual(plan.verification, [{ kind: "mcp-server-block-matches", serverName: "dsh_agentlink" }]);
  assert.equal(plan.warnings.some((warning) => warning.includes("Restart Codex")), true);
  assert.equal(operation.serverName, "dsh_agentlink");
  assert.deepEqual(operation.legacyServerNames, ["dsh_collab"]);
  assert.equal(operation.command, "/usr/local/bin/node");
  assert.deepEqual(operation.args, ["/tmp/dsh-Agentlink/dist/index.js"]);
  assert.deepEqual(operation.env, {
    DSH_HOST_URL: "http://127.0.0.1:3080",
    DSH_HOST_VERSION: "0.1.0-rc.7",
    DSH_BRIDGE_AGENT_PRESET: "code",
  });
  assert.deepEqual(operation.humanApproval, { toolName: "dsh_resolve_approval", mode: "human-prompt" });
  assert.match(plan.restartHint, /Restart Codex/);
  assert.match(rendered, /\[mcp_servers\.dsh_agentlink]/);
  assert.match(rendered, /approval_mode = "prompt"/);
  assert.equal(verifyCodexMcpConfig(`${existingConfig}\n${rendered}\n`, operation), true);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('model = "private"'), false);
  assert.equal(serialized.includes("content"), false);
  assert.equal(serialized.includes("renderedBlock"), false);
});

test("setup adds the bridge without changing unrelated Codex configuration", () => {
  const original = `model = "gpt-test"\n\n[mcp_servers.other]\ncommand = "other"\n`;
  const updated = upsertMcpConfig(original, block, false);

  assert.match(updated, /^model = "gpt-test"/);
  assert.match(updated, /\[mcp_servers\.other]\ncommand = "other"/);
  assert.equal(extractBridgeConfig(updated), block);
  assert.equal(hasBridgeConfig(updated), true);
});

test("setup preserves unrelated TOML array tables", () => {
  const original = `[[profiles]]\nname = "test"\n`;
  const updated = upsertMcpConfig(original, block, false);

  assert.match(updated, /^\[\[profiles]]\nname = "test"/);
  assert.equal(extractBridgeConfig(updated), block);
});

test("setup preserves unrelated array tables after the bridge during replacement", () => {
  const original = `${block}\n\n[[profiles]]\nname = "after-bridge"\n`;
  const updated = upsertMcpConfig(original, block, true);

  assert.equal(extractBridgeConfig(updated), block);
  assert.match(updated, /\[\[profiles]]\nname = "after-bridge"/);
});

test("setup requires explicit replacement and removes only dsh_agentlink tables", () => {
  const original = `[mcp_servers.dsh_agentlink]\ncommand = "old"\n\n[mcp_servers.dsh_agentlink.env]\nOLD = "value"\n\n[mcp_servers.other]\ncommand = "keep"\n`;

  assert.throws(() => upsertMcpConfig(original, block, false), /already exists/);
  const updated = upsertMcpConfig(original, block, true);
  assert.equal(updated.includes('command = "old"'), false);
  assert.equal(updated.includes('OLD = "value"'), false);
  assert.match(updated, /\[mcp_servers\.other]\ncommand = "keep"/);
  assert.equal(extractBridgeConfig(updated), block);
});

test("setup migrates legacy dsh_collab without leaving two bridge identities", () => {
  const legacy = `[mcp_servers.dsh_collab]\ncommand = "legacy"\n\n[mcp_servers.dsh_collab.env]\nOLD = "value"\n\n[mcp_servers.other]\ncommand = "keep"\n`;

  assert.throws(() => upsertMcpConfig(legacy, block, false), /legacy dsh_collab already exists/);
  const migrated = upsertMcpConfig(legacy, block, true);
  assert.equal(migrated.includes("mcp_servers.dsh_collab"), false);
  assert.match(migrated, /\[mcp_servers\.dsh_agentlink]/);
  assert.match(migrated, /\[mcp_servers\.other]\ncommand = "keep"/);

  const duplicate = `${legacy}\n[mcp_servers.dsh_agentlink]\ncommand = "duplicate"\n`;
  const repaired = upsertMcpConfig(duplicate, block, true);
  assert.equal(repaired.includes("mcp_servers.dsh_collab"), false);
  assert.equal((repaired.match(/\[mcp_servers\.dsh_agentlink]/g) ?? []).length, 1);
  assert.equal(repaired.includes('command = "duplicate"'), false);
});

test("setup recognizes quoted target tables but refuses ambiguous TOML forms", () => {
  const quoted = `[mcp_servers."dsh_agentlink"]\ncommand = "old"\n\n[mcp_servers.other]\ncommand = "keep"\n`;
  const replaced = upsertMcpConfig(quoted, block, true);
  assert.equal(replaced.includes('command = "old"'), false);
  assert.match(replaced, /\[mcp_servers\.other]/);

  assert.throws(
    () => upsertMcpConfig('mcp_servers.dsh_agentlink.command = "node"\n', block, true),
    /inline\/dotted/,
  );
  assert.throws(
    () => upsertMcpConfig('mcp_servers.dsh_collab.command = "node"\n', block, true),
    /inline\/dotted/,
  );
  assert.throws(
    () => upsertMcpConfig('notes = """\n[mcp_servers.dsh_collab]\n"""\n', block, true),
    /multiline TOML string/,
  );
  assert.throws(
    () => upsertMcpConfig('[[mcp_servers.dsh_agentlink]]\ncommand = "node"\n', block, true),
    /array-table/,
  );
});

test("setup rejects root-level inline bridge definitions before append and verification", () => {
  const operation = createCodexInstallPlan({
    configPath: "/tmp/codex/config.toml",
    nodePath: "/Applications/Node Runtime/bin/node",
    entryPath: "/tmp/dsh Agentlink/dist/index.js",
    hostUrl: "http://127.0.0.1:3080",
    dshVersion: "0.1.0-rc.6",
    preset: "code",
    replace: false,
  }).operations[0];
  assert.equal(operation?.kind, "upsert-mcp-server");

  for (const config of [
    'mcp_servers.dsh_agentlink = { command = "old" }\n',
    'mcp_servers."dsh_agentlink" = { command = "old" }\n',
    'mcp_servers.dsh_collab = { command = "legacy" }\n',
    'mcp_servers."dsh_collab" = { command = "legacy" }\n',
  ]) {
    assert.throws(() => upsertMcpConfig(config, block, false), /inline\/dotted/);
    assert.throws(() => upsertMcpConfig(config, block, true), /inline\/dotted/);
    assert.equal(verifyCodexMcpConfig(`${config}${block}\n`, operation), false);
  }
});

test("setup rejects root-level whole-inline-table mcp_servers before append and verification", () => {
  const operation = createCodexInstallPlan({
    configPath: "/tmp/codex/config.toml",
    nodePath: "/Applications/Node Runtime/bin/node",
    entryPath: "/tmp/dsh Agentlink/dist/index.js",
    hostUrl: "http://127.0.0.1:3080",
    dshVersion: "0.1.0-rc.6",
    preset: "code",
    replace: false,
  }).operations[0];
  assert.equal(operation?.kind, "upsert-mcp-server");

  for (const config of [
    'mcp_servers = { dsh_agentlink = { command = "old" } }\n',
    'mcp_servers = { dsh_collab = { command = "legacy" } }\n',
    '"mcp_servers" = { dsh_agentlink = { command = "old" } }\n',
    'mcp_servers={ dsh_agentlink = { command = "old" } }\n',
    // No bridge entry inside: appending a table would still break the file,
    // because TOML forbids extending an inline table.
    'mcp_servers = { other = { command = "other" } }\n',
  ]) {
    assert.throws(() => upsertMcpConfig(config, block, false), /root-level inline mcp_servers table/);
    assert.throws(() => upsertMcpConfig(config, block, true), /root-level inline mcp_servers table/);
    assert.equal(verifyCodexMcpConfig(`${config}${block}\n`, operation), false);
  }
});

test("setup does not reject legal configs that merely mention mcp_servers", () => {
  const legal = [
    // A comment naming the inline form.
    '# mcp_servers = { dsh_agentlink = { command = "old" } }\n',
    // An unrelated key whose string value mentions the pattern.
    'note = "mcp_servers = { dsh_agentlink = {} }"\n',
    // A dotted key for a non-bridge server plus a legal bridge table.
    'mcp_servers.other.command = "other"\n',
  ];
  for (const prefix of legal) {
    const updated = upsertMcpConfig(`${prefix}\n[profile.default]\n`, block, false);
    assert.match(updated, /\[mcp_servers\.dsh_agentlink]/);
  }
});

test("setup allows a whole-inline-table mcp_servers scoped under another table", () => {
  // Under [profile.default] this defines profile.default.mcp_servers, not the
  // root key, so appending [mcp_servers.dsh_agentlink] is valid TOML.
  const config = '[profile.default]\nmcp_servers = { other = { command = "other" } }\n';
  const updated = upsertMcpConfig(config, block, false);
  assert.match(updated, /\[mcp_servers\.dsh_agentlink]/);
});

test("setup rejects escaped or quoted root keys spelling mcp_servers", () => {
  for (const config of [
    '"mcp\\u005fservers" = { other = { command = "other" } }\n',
    "'mcp_servers' = { other = { command = \"other\" } }\n",
    'mcp_servers."dsh\\u005fagentlink" = { command = "old" }\n',
    '"mcp_servers".dsh_agentlink = { command = "old" }\n',
  ]) {
    assert.throws(() => upsertMcpConfig(config, block, false), /inline/);
  }
});

test("setup detects bridge tables whose names use escaped or quoted keys", () => {
  assert.equal(hasBridgeConfig('[mcp_servers."dsh\\u005fagentlink"]\ncommand = "old"\n'), true);
  assert.equal(hasBridgeConfig('["mcp_servers".dsh_collab]\ncommand = "old"\n'), true);
  assert.throws(
    () => upsertMcpConfig('[mcp_servers."dsh\\u005fagentlink"]\ncommand = "old"\n', block, false),
    /already exists/,
  );
});

test("setup does not report inline duplicates plus a matching table as an installed no-op", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-agentlink-inline-noop-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.toml");
  const invalid = `mcp_servers.dsh_agentlink = { command = "old" }\n\n${block}\n`;
  await writeFile(configPath, invalid, { mode: 0o600 });
  const expected = await readConfigSnapshot(configPath);
  const plan = createCodexInstallPlan({
    configPath,
    nodePath: "/Applications/Node Runtime/bin/node",
    entryPath: "/tmp/dsh Agentlink/dist/index.js",
    hostUrl: "http://127.0.0.1:3080",
    dshVersion: "0.1.0-rc.6",
    preset: "code",
    replace: false,
  });

  await assert.rejects(() => installMcpConfigFile(configPath, block, false, expected), /inline\/dotted/);
  await assert.rejects(() => installCodexPlan(plan, expected), /inline\/dotted/);
  assert.equal(await readFile(configPath, "utf8"), invalid);
});

test("setup flags parse non-interactive and replacement choices", () => {
  assert.deepEqual(
    parseSetupArgs([
      "--yes",
      "--replace",
      "--host",
      "http://localhost:3080",
      "--preset=research",
      "--config",
      "/tmp/codex config.toml",
      "--skip-doctor",
    ]),
    {
      yes: true,
      replace: true,
      dryRun: false,
      skipDoctor: true,
      noPreset: false,
      help: false,
      host: "http://localhost:3080",
      preset: "research",
      configPath: "/tmp/codex config.toml",
    },
  );
  assert.throws(() => parseSetupArgs(["--preset", "code", "--no-preset"]), /cannot be used together/);
});

test("setup resolves the Codex config root without repurposing the environment", () => {
  assert.equal(defaultCodexConfigPath({ CODEX_HOME: "/tmp/custom-codex" }), "/tmp/custom-codex/config.toml");
  assert.equal(
    codexIntegration.defaultConfigPath({ cwd: "/tmp/project", env: { CODEX_HOME: "/tmp/custom-codex" } }),
    "/tmp/custom-codex/config.toml",
  );
});

test("setup backs up an existing config and preserves private file modes", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-agentlink-setup-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.toml");
  const original = `model = "gpt-test"\n`;
  await writeFile(configPath, original, { mode: 0o640 });
  await chmod(configPath, 0o640);
  const expected = await readConfigSnapshot(configPath);

  const result = await installMcpConfigFile(configPath, block, false, expected);

  assert.equal(result.changed, true);
  assert.notEqual(result.backupPath, undefined);
  assert.equal(await readFile(result.backupPath as string, "utf8"), original);
  assert.equal((await stat(configPath)).mode & 0o777, 0o640);
  assert.equal((await stat(result.backupPath as string)).mode & 0o777, 0o640);
  assert.match(await readFile(configPath, "utf8"), /^model = "gpt-test"/);
});

test("setup refuses symlinked config files", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-agentlink-setup-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const targetPath = join(directory, "target.toml");
  const configPath = join(directory, "config.toml");
  await writeFile(targetPath, `model = "gpt-test"\n`);
  await symlink(targetPath, configPath);

  await assert.rejects(() => installMcpConfigFile(configPath, block, false), /refusing to replace symlinked/);
  assert.equal(await readFile(targetPath, "utf8"), `model = "gpt-test"\n`);
});

test("setup aborts when the config changes after review", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-agentlink-setup-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.toml");
  await writeFile(configPath, `model = "before"\n`, { mode: 0o600 });
  const reviewed = await readConfigSnapshot(configPath);
  await writeFile(configPath, `model = "after"\n`, { mode: 0o600 });

  await assert.rejects(
    () => installMcpConfigFile(configPath, block, false, reviewed),
    /changed during setup/,
  );
  assert.equal(await readFile(configPath, "utf8"), `model = "after"\n`);
});
