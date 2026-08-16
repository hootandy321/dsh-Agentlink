import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  claudeCodeSupportsHumanApprovalPrompt,
  claudeCodeSkillTargetPath,
  createClaudeCodeInstallPlan,
  describeClaudeCodeApprovalCapability,
  installClaudeCodeSkill,
  installClaudeCodePlan,
  parseClaudeCodeVersion,
  parseSetupArgs,
  readCanonicalClaudeCodeSkill,
  readConfigSnapshot,
  renderClaudeCodeOperation,
  resolveClaudeCodeProjectRoot,
} from "../src/setup-claude-code.js";

function planFor(projectRoot: string, replace = false) {
  return createClaudeCodeInstallPlan({
    cwd: projectRoot,
    nodePath: "/usr/local/bin/node",
    entryPath: "/tmp/dsh-Agentlink/dist/index.js",
    hostUrl: "http://127.0.0.1:3080",
    dshVersion: "0.1.0-rc.7",
    preset: "code",
    replace,
  });
}

function planForSkill(projectRoot: string, replaceSkill = false) {
  return createClaudeCodeInstallPlan({
    cwd: projectRoot,
    nodePath: "/usr/local/bin/node",
    entryPath: "/tmp/dsh-Agentlink/dist/index.js",
    hostUrl: "http://127.0.0.1:3080",
    dshVersion: "0.1.0-rc.7",
    preset: "code",
    replace: false,
    installSkill: true,
    replaceSkill,
    skillSourcePath: "/tmp/dsh-Agentlink/skill/claude-code-dsh/SKILL.md",
    skillContent: "canonical project skill\n",
  });
}

test("Claude Code setup parses flags consistently with the Codex setup", () => {
  assert.deepEqual(
    parseSetupArgs([
      "--yes",
      "--replace",
      "--replace-skill",
      "--host",
      "http://localhost:3080",
      "--preset=research",
      "--project",
      "/tmp/target project",
      "--dry-run",
      "--skip-doctor",
    ]),
    {
      yes: true,
      replace: true,
      replaceSkill: true,
      noSkill: false,
      dryRun: true,
      skipDoctor: true,
      noPreset: false,
      help: false,
      host: "http://localhost:3080",
      preset: "research",
      projectPath: "/tmp/target project",
    },
  );
  assert.throws(() => parseSetupArgs(["--config", "/tmp/project/.mcp.json"]), /unknown option: --config/);
  assert.throws(() => parseSetupArgs(["--config=/tmp/project/.mcp.json"]), /unknown option: --config/);
  assert.throws(() => parseSetupArgs(["--preset", "code", "--no-preset"]), /cannot be used together/);
  assert.throws(() => parseSetupArgs(["--replace-skill", "--no-skill"]), /cannot be used together/);
  assert.equal(parseSetupArgs(["--no-skill"]).noSkill, true);
});

test("Claude Code setup resolves an existing project directory and rejects file targets", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-agentlink-claude-project-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "not-a-project");
  await writeFile(filePath, "not a directory");

  assert.equal(await resolveClaudeCodeProjectRoot(undefined, directory), await realpath(directory));
  await assert.rejects(() => resolveClaudeCodeProjectRoot(filePath, directory), /not a directory/);
  await assert.rejects(() => resolveClaudeCodeProjectRoot(join(directory, "missing"), directory), /does not exist/);
});

test("Claude Code version parser supports known CLI output formats", () => {
  assert.equal(parseClaudeCodeVersion("2.1.222 (Claude Code)\n"), "2.1.222");
  assert.equal(parseClaudeCodeVersion("Claude Code v2.1.222\n"), "2.1.222");
  assert.equal(parseClaudeCodeVersion("Claude Code 2.1.199\n"), "2.1.199");
  assert.equal(parseClaudeCodeVersion("Claude Code 2.1.199-beta.1\n"), "2.1.199-beta.1");
  assert.equal(parseClaudeCodeVersion("Claude Code 2.1.199+build.1\n"), "2.1.199+build.1");
  assert.equal(parseClaudeCodeVersion("Claude Code 2.1.199-beta.1+build.1\n"), "2.1.199-beta.1+build.1");
  assert.equal(parseClaudeCodeVersion("Claude Code\n"), undefined);
  assert.equal(claudeCodeSupportsHumanApprovalPrompt("2.1.198"), false);
  assert.equal(claudeCodeSupportsHumanApprovalPrompt("2.1.199"), true);
  assert.equal(claudeCodeSupportsHumanApprovalPrompt("2.1.199-beta.1"), false);
  assert.equal(claudeCodeSupportsHumanApprovalPrompt("2.1.199+build.1"), true);
  assert.equal(claudeCodeSupportsHumanApprovalPrompt("2.1.200-beta.1"), false);
  assert.equal(claudeCodeSupportsHumanApprovalPrompt("2.2.0"), true);
  assert.equal(claudeCodeSupportsHumanApprovalPrompt("999999999999999999999.0.0"), false);
  assert.equal(claudeCodeSupportsHumanApprovalPrompt(undefined), undefined);
  assert.match(describeClaudeCodeApprovalCapability("2.1.198"), /unsupported/);
  assert.match(describeClaudeCodeApprovalCapability(undefined), /unknown/);
});

test("Claude Code setup installs .mcp.json atomically and preserves private modes", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-agentlink-claude-setup-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, ".mcp.json");
  const original = JSON.stringify({ mcpServers: { other: { command: "other" } } }, null, 2);
  await writeFile(configPath, original, { mode: 0o640 });
  await chmod(configPath, 0o640);
  const installPlan = planFor(directory);
  const operation = installPlan.operations[0];
  if (operation?.kind !== "upsert-mcp-server") throw new Error("expected MCP server operation");
  const expected = await readConfigSnapshot(configPath);

  const result = await installClaudeCodePlan(installPlan, expected);
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers: Record<string, unknown> };

  assert.equal(result.changed, true);
  assert.notEqual(result.backupPath, undefined);
  assert.equal(await readFile(result.backupPath as string, "utf8"), original);
  assert.equal((await stat(configPath)).mode & 0o777, 0o640);
  assert.deepEqual(parsed.mcpServers.dsh_agentlink, renderClaudeCodeOperation(operation));
});

test("Claude Code setup reports no-op when config already matches", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-agentlink-claude-setup-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, ".mcp.json");
  const installPlan = planFor(directory);
  const operation = installPlan.operations[0];
  if (operation?.kind !== "upsert-mcp-server") throw new Error("expected MCP server operation");
  await writeFile(
    configPath,
    `${JSON.stringify({ mcpServers: { dsh_agentlink: renderClaudeCodeOperation(operation) } }, null, 2)}\n`,
  );

  assert.deepEqual(await installClaudeCodePlan(installPlan), { changed: false });
});

test("Claude Code setup refuses symlinked project .mcp.json", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-agentlink-claude-setup-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const targetPath = join(directory, "target.json");
  const configPath = join(directory, ".mcp.json");
  await writeFile(targetPath, "{}\n");
  await symlink(targetPath, configPath);

  await assert.rejects(() => readConfigSnapshot(configPath), /refusing to replace symlinked config/);
});

test("Claude Code setup refuses stale snapshots", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-agentlink-claude-setup-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, ".mcp.json");
  await writeFile(configPath, `${JSON.stringify({ mcpServers: { other: { command: "before" } } }, null, 2)}\n`);
  const expected = await readConfigSnapshot(configPath);
  await writeFile(configPath, `${JSON.stringify({ mcpServers: { other: { command: "after" } } }, null, 2)}\n`);

  await assert.rejects(() => installClaudeCodePlan(planFor(directory), expected), /config changed during setup/);
  const current = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers: { other: { command: string } } };
  assert.equal(current.mcpServers.other.command, "after");
});

test("Claude Code setup installs MCP and project skill from one install plan", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-agentlink-claude-combined-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, ".mcp.json");
  const skillPath = claudeCodeSkillTargetPath(directory);

  const result = await installClaudeCodePlan(planForSkill(directory));

  assert.equal(result.changed, true);
  assert.equal(result.skill?.changed, true);
  assert.equal(result.skill?.path, skillPath);
  assert.equal(await readFile(skillPath, "utf8"), "canonical project skill\n");
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers: Record<string, unknown> };
  assert.equal(Object.hasOwn(parsed.mcpServers, "dsh_agentlink"), true);
});

test("Claude Code setup preflights skill conflicts before mutating MCP config", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-agentlink-claude-combined-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, ".mcp.json");
  const skillPath = claudeCodeSkillTargetPath(directory);
  await mkdir(join(directory, ".claude", "skills", "claude-code-dsh"), { recursive: true });
  await writeFile(skillPath, "custom local skill\n");

  await assert.rejects(() => installClaudeCodePlan(planForSkill(directory)), /--replace-skill/);
  await assert.rejects(() => readFile(configPath, "utf8"), /ENOENT/);
  assert.equal(await readFile(skillPath, "utf8"), "custom local skill\n");
});

test("Claude Code setup installs the project skill by default and reports no-op when current", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-agentlink-claude-skill-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const skillPath = claudeCodeSkillTargetPath(directory);
  const canonical = await readCanonicalClaudeCodeSkill();

  const first = await installClaudeCodeSkill({ projectRoot: directory, replaceSkill: false, content: canonical });
  const second = await installClaudeCodeSkill({ projectRoot: directory, replaceSkill: false, content: canonical });

  assert.deepEqual(first, { changed: true, path: skillPath });
  assert.deepEqual(second, { changed: false, path: skillPath });
  assert.equal(await readFile(skillPath, "utf8"), canonical);
  assert.equal((await stat(skillPath)).mode & 0o777, 0o600);
});

test("Claude Code setup refuses to overwrite a different project skill without --replace-skill", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-agentlink-claude-skill-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const skillPath = claudeCodeSkillTargetPath(directory);
  await mkdir(join(directory, ".claude", "skills", "claude-code-dsh"), { recursive: true });
  await writeFile(skillPath, "custom local skill\n");

  await assert.rejects(
    () => installClaudeCodeSkill({ projectRoot: directory, replaceSkill: false, content: "canonical skill\n" }),
    /--replace-skill/,
  );
  assert.equal(await readFile(skillPath, "utf8"), "custom local skill\n");
});

test("Claude Code setup replaces a different project skill only with --replace-skill", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-agentlink-claude-skill-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const skillPath = claudeCodeSkillTargetPath(directory);
  await mkdir(join(directory, ".claude", "skills", "claude-code-dsh"), { recursive: true });
  await writeFile(skillPath, "old skill\n", { mode: 0o640 });
  await chmod(skillPath, 0o640);

  const result = await installClaudeCodeSkill({ projectRoot: directory, replaceSkill: true, content: "new skill\n" });

  assert.equal(result.changed, true);
  assert.equal(result.path, skillPath);
  assert.notEqual(result.backupPath, undefined);
  assert.equal(await readFile(skillPath, "utf8"), "new skill\n");
  assert.equal(await readFile(result.backupPath as string, "utf8"), "old skill\n");
  assert.equal((await stat(skillPath)).mode & 0o777, 0o640);
});

test("Claude Code setup refuses symlinked project skill target or parent directories", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-agentlink-claude-skill-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outside = await mkdtemp(join(tmpdir(), "dsh-agentlink-claude-outside-"));
  context.after(() => rm(outside, { recursive: true, force: true }));

  await symlink(outside, join(directory, ".claude"));
  await assert.rejects(
    () => installClaudeCodeSkill({ projectRoot: directory, replaceSkill: false, content: "canonical skill\n" }),
    /symlinked directory/,
  );

  await rm(join(directory, ".claude"));
  await mkdir(join(directory, ".claude", "skills", "claude-code-dsh"), { recursive: true });
  const target = join(directory, ".claude", "skills", "claude-code-dsh", "SKILL.md");
  const outsideFile = join(outside, "SKILL.md");
  await writeFile(outsideFile, "outside\n");
  await symlink(outsideFile, target);

  await assert.rejects(
    () => installClaudeCodeSkill({ projectRoot: directory, replaceSkill: true, content: "canonical skill\n" }),
    /symlinked config/,
  );
  assert.equal(await readFile(outsideFile, "utf8"), "outside\n");
});
