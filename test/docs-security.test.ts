import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

test("public docs and skill preserve connect-only, approval, cancellation, and recovery safety contracts", async () => {
  const [readme, architecture, manualConfiguration, skill] = await Promise.all([
    readFile(new URL("README.md", root), "utf8"),
    readFile(new URL("docs/architecture.md", root), "utf8"),
    readFile(new URL("docs/manual-configuration.md", root), "utf8"),
    readFile(new URL("skill/codex-dsh/SKILL.md", root), "utf8"),
  ]);
  for (const phrase of [
    "connect-only",
    "approval_mode = \"prompt\"",
    "dsh_release_workspace",
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
    "Full simultaneous multi-Codex plus interactive-Web conflict freedom is not claimed",
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
    assert.equal(skill.includes(phrase), true, `skill lost required safety phrase: ${phrase}`);
  }
});
