import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  defaultCodexConfigPath,
  extractBridgeConfig,
  hasBridgeConfig,
  installMcpConfigFile,
  parseSetupArgs,
  readConfigSnapshot,
  renderMcpConfig,
  upsertMcpConfig,
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

test("setup adds the bridge without changing unrelated Codex configuration", () => {
  const original = `model = "gpt-test"\n\n[mcp_servers.other]\ncommand = "other"\n`;
  const updated = upsertMcpConfig(original, block, false);

  assert.match(updated, /^model = "gpt-test"/);
  assert.match(updated, /\[mcp_servers\.other]\ncommand = "other"/);
  assert.equal(extractBridgeConfig(updated), block);
  assert.equal(hasBridgeConfig(updated), true);
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
