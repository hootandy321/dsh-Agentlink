import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { WorkspaceClaimConflictError, WorkspaceClaimStore } from "../src/workspace-claim.js";

const rootTask = "dsh_000000000001";
const childTask = "dsh_000000000002";
const siblingTask = "dsh_000000000003";

test("WorkspaceClaimStore persists only coordination fields with private permissions", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-claims-"));
  try {
    const store = new WorkspaceClaimStore(home);
    const claim = await store.acquire({
      canonicalCwd: join(home, "work"),
      taskId: rootTask,
      sessionId: "session-root",
      mode: "exclusive-write",
    });
    const path = join(home, "claims", `${rootTask}.json`);
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

    assert.deepEqual(Object.keys(raw).sort(), ["createdAt", "cwd", "mode", "sessionId", "taskId"]);
    assert.equal(raw.cwd, join(home, "work"));
    assert.equal(raw.taskId, rootTask);
    assert.equal(raw.sessionId, "session-root");
    assert.equal(raw.mode, "exclusive-write");
    assert.equal(typeof raw.createdAt, "string");
    assert.deepEqual(await store.get(rootTask), claim);
    assert.deepEqual(await store.list(), [claim]);
    assert.equal((await stat(join(home, "claims"))).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("WorkspaceClaimStore allows overlapping read-only claims but rejects exclusive-write overlaps", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-claims-"));
  try {
    const store = new WorkspaceClaimStore(home);
    await store.acquire({
      canonicalCwd: join(home, "repo"),
      taskId: rootTask,
      sessionId: "session-1",
      mode: "read-only",
    });
    await store.acquire({
      canonicalCwd: join(home, "repo", "src"),
      taskId: childTask,
      sessionId: "session-2",
      mode: "read-only",
    });
    await store.acquire({
      canonicalCwd: join(home, "other"),
      taskId: siblingTask,
      sessionId: "session-3",
      mode: "exclusive-write",
    });

    await assert.rejects(
      () =>
        store.acquire({
          canonicalCwd: join(home, "repo", "src", "feature"),
          taskId: "dsh_000000000004",
          sessionId: "session-4",
          mode: "exclusive-write",
        }),
      (error: unknown) => error instanceof WorkspaceClaimConflictError && error.code === "workspace_conflict",
    );
    await assert.rejects(
      () =>
        store.acquire({
          canonicalCwd: home,
          taskId: "dsh_000000000005",
          sessionId: "session-5",
          mode: "exclusive-write",
        }),
      (error: unknown) => error instanceof WorkspaceClaimConflictError && error.code === "workspace_conflict",
    );
    assert.equal((await store.list()).length, 3);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("WorkspaceClaimStore release removes claims and reports stale views", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-claims-"));
  try {
    const store = new WorkspaceClaimStore(home);
    const claim = await store.acquire({
      canonicalCwd: join(home, "repo"),
      taskId: rootTask,
      sessionId: "session-1",
      mode: "exclusive-write",
    });

    assert.deepEqual(await store.release(rootTask), claim);
    assert.equal(await store.get(rootTask), undefined);
    assert.deepEqual(await store.list(), []);
    await assert.rejects(
      () => store.release(rootTask),
      (error: unknown) => error instanceof WorkspaceClaimConflictError && error.code === "stale_view",
    );
    await store.acquire({
      canonicalCwd: join(home, "repo"),
      taskId: rootTask,
      sessionId: "session-1",
      mode: "read-only",
    });
    await assert.rejects(
      () =>
        store.acquire({
          canonicalCwd: join(home, "repo"),
          taskId: rootTask,
          sessionId: "session-1",
          mode: "read-only",
        }),
      (error: unknown) => error instanceof WorkspaceClaimConflictError && error.code === "stale_view",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("WorkspaceClaimStore serializes two instances through the registry lock", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-claims-"));
  try {
    const left = new WorkspaceClaimStore(home);
    const right = new WorkspaceClaimStore(home);
    const results = await Promise.allSettled([
      left.acquire({
        canonicalCwd: join(home, "repo"),
        taskId: rootTask,
        sessionId: "session-1",
        mode: "exclusive-write",
      }),
      right.acquire({
        canonicalCwd: join(home, "repo", "src"),
        taskId: childTask,
        sessionId: "session-2",
        mode: "read-only",
      }),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(
      rejected?.status === "rejected" &&
        rejected.reason instanceof WorkspaceClaimConflictError &&
        rejected.reason.code === "workspace_conflict",
      true,
    );
    assert.equal((await left.list()).length, 1);
    assert.deepEqual(await left.list(), await right.list());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("WorkspaceClaimStore rejects malformed persisted claims as stale views", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-claims-"));
  try {
    const store = new WorkspaceClaimStore(home);
    await mkdir(join(home, "claims"), { recursive: true });
    await writeFile(
      join(home, "claims", `${rootTask}.json`),
      JSON.stringify({ taskId: rootTask, cwd: join(home, "repo") }),
    );

    await assert.rejects(
      () => store.get(rootTask),
      (error: unknown) => error instanceof WorkspaceClaimConflictError && error.code === "stale_view",
    );
    await writeFile(
      join(home, "claims", `${rootTask}.json`),
      JSON.stringify({
        taskId: rootTask,
        sessionId: "session-root",
        cwd: join(home, "repo"),
        mode: "exclusive-write",
        createdAt: new Date().toISOString(),
        prompt: "must-not-surface",
      }),
    );
    await assert.rejects(
      () => store.get(rootTask),
      (error: unknown) => error instanceof WorkspaceClaimConflictError && error.code === "stale_view",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
