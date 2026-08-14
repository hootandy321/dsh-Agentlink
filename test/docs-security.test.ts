import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

test("README and skill preserve connect-only, approval, cancellation, and recovery safety contracts", async () => {
  const [readme, skill] = await Promise.all([
    readFile(new URL("README.md", root), "utf8"),
    readFile(new URL("skill/codex-dsh/SKILL.md", root), "utf8"),
  ]);
  for (const phrase of [
    "connect-only",
    "approval_mode = \"prompt\"",
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
    "not a DSH Cordis bundle",
    "Do not install it with `dsh plugin --profile ... add ...`",
  ]) {
    assert.equal(readme.includes(phrase), true, `README lost required safety phrase: ${phrase}`);
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
