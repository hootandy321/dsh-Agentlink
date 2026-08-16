import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { renderDshSkill } from "../src/skill-content.js";

const root = new URL("../", import.meta.url);

test("public docs and skill preserve connect-only, approval, cancellation, and recovery safety contracts", async () => {
  const [readme, architecture, manualConfiguration, codexSkill, claudeCodeSkill] = await Promise.all([
    readFile(new URL("README.md", root), "utf8"),
    readFile(new URL("docs/architecture.md", root), "utf8"),
    readFile(new URL("docs/manual-configuration.md", root), "utf8"),
    readFile(new URL("skill/codex-dsh/SKILL.md", root), "utf8"),
    readFile(new URL("skill/claude-code-dsh/SKILL.md", root), "utf8"),
  ]);
  for (const phrase of [
    "connect-only",
    "approval_mode = \"prompt\"",
    "dsh_release_workspace",
    "workspace claim semantics",
    "not a DSH Cordis bundle",
    "Do not install it with `dsh plugin --profile ... add ...`",
  ]) {
    assert.equal(readme.includes(phrase), true, `README lost required safety phrase: ${phrase}`);
  }
  for (const phrase of [
    "approval_mode = \"prompt\"",
    "DSH_ALLOW_REMOTE_HOST=true",
    "not a DSH Cordis bundle",
    "Do not install it with `dsh plugin --profile ... add ...`",
  ]) {
    assert.equal(
      manualConfiguration.includes(phrase),
      true,
      `manual configuration doc lost required safety phrase: ${phrase}`,
    );
  }
  for (const phrase of [
    "never automatically allows",
    "approval policy `never`",
    "at-least-once with deterministic dedupe",
    "unrecoverable_gap",
    "terminal_missing_final",
    "non-atomic",
    "only source of truth for conversation content",
    "inter-process locks",
    "dsh_release_workspace",
    "Full simultaneous multi-caller plus interactive-Web conflict freedom is not claimed",
    "workspaceClaimSemantics.controlsDshSandbox=false",
    "Real browser-visible end-to-end interaction",
  ]) {
    assert.equal(
      architecture.includes(phrase),
      true,
      `architecture doc lost required safety phrase: ${phrase}`,
    );
  }
  for (const phrase of [
    "never start",
    "Never auto-allow",
    "host_unreachable",
    "background jobs",
    "only conversation-content source",
    "dsh_release_workspace",
    "supervising Codex must not edit",
    "not a DSH Cordis bundle",
    "must not be installed with `dsh plugin --profile ... add ...`",
  ]) {
    assert.equal(codexSkill.includes(phrase), true, `Codex skill lost required safety phrase: ${phrase}`);
  }
  for (const [label, skill] of [
    ["Codex skill", codexSkill],
    ["Claude Code skill", claudeCodeSkill],
  ] as const) {
    for (const phrase of [
      "The shipped `code` preset",
      "contentUnavailable",
      "cursor_expired",
      "unrecoverable_gap",
      "terminal_missing_final",
      "workspace claim is cooperative",
      "workspaceClaimSemantics.controlsDshSandbox=false",
      "Never auto-allow",
      "Never auto-approve",
    ]) {
      assert.equal(skill.includes(phrase), true, `${label} lost shared safety phrase: ${phrase}`);
    }
  }
  for (const phrase of [
    "connect-only",
    "never start",
    "Never auto-approve",
    "Headless or `dontAsk` operation cannot complete human approval safely",
    "host_unreachable",
    "background jobs",
    "only conversation-content source",
    "dsh_release_workspace",
    "supervising Claude Code session must not edit",
  ]) {
    assert.equal(claudeCodeSkill.includes(phrase), true, `Claude Code skill lost required safety phrase: ${phrase}`);
  }
});

test("caller skill artifacts are generated from the canonical renderer", async () => {
  const [codexSkill, claudeCodeSkill] = await Promise.all([
    readFile(new URL("skill/codex-dsh/SKILL.md", root), "utf8"),
    readFile(new URL("skill/claude-code-dsh/SKILL.md", root), "utf8"),
  ]);

  assert.equal(codexSkill, renderDshSkill("codex"));
  assert.equal(claudeCodeSkill, renderDshSkill("claude-code"));
});
