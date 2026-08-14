import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { TaskStore, TaskStoreError } from "../src/task-store.js";

test("TaskStore persists only taskId to sessionId with private permissions", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-store-"));
  try {
    const store = new TaskStore(home);
    const record = await store.create("session-root");
    const path = join(home, "tasks", `${record.taskId}.json`);
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

    assert.deepEqual(Object.keys(raw).sort(), ["sessionId", "taskId"]);
    assert.deepEqual(await store.get(record.taskId), record);
    assert.deepEqual(await store.list(), [record]);
    assert.equal((await stat(join(home, "tasks"))).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("TaskStore rejects invalid ids, malformed mappings, and content-bearing extras", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-store-"));
  try {
    const store = new TaskStore(home);
    await assert.rejects(() => store.get("../escape"), TaskStoreError);

    await mkdir(join(home, "tasks"), { recursive: true });
    await writeFile(join(home, "tasks", "dsh_000000000001.json"), "{not-json}\n");
    await assert.rejects(() => store.get("dsh_000000000001"), TaskStoreError);

    await writeFile(
      join(home, "tasks", "dsh_000000000002.json"),
      JSON.stringify({ taskId: "dsh_000000000002", sessionId: "session-2", prompt: "must-not-surface" }),
    );
    await assert.rejects(() => store.get("dsh_000000000002"), TaskStoreError);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
