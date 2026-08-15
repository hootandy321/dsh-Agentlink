import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { withFileLock } from "../src/file-lock.js";

const maker = (token: string, pid = process.pid) =>
  JSON.stringify({ pid, token, createdAt: new Date().toISOString() });

test("withFileLock retries on ENOENT after mkdir (lost race), then acquires and runs work", async (t) => {
  const base = await fs.mkdtemp(join(tmpdir(), "flock-enoent-"));
  try {
    const lockDir = join(base, "lock");
    const ownerPath = join(lockDir, "owner.json");
    const writeFile = fs.writeFile.bind(fs);
    let interceptOnce = true;
    t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
      const [path] = args;
      if (path === ownerPath && interceptOnce) {
        interceptOnce = false;
        await fs.rm(lockDir, { recursive: true, force: true });
      }
      return writeFile(...args);
    });

    let workRan = false;
    const result = await withFileLock(lockDir, async () => {
      workRan = true;
      return "done";
    }, { timeoutMs: 2000, retryMs: 5, staleMs: 5_000 });

    assert.equal(result, "done");
    assert.equal(workRan, true);
    // lock fully released after work
    await assert.rejects(fs.stat(lockDir));
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("withFileLock on EEXIST (competitor replaces dir) retries, never deletes competitor owner, never runs work", async (t) => {
  const base = await fs.mkdtemp(join(tmpdir(), "flock-eexist-"));
  try {
    const lockDir = join(base, "lock");
    const ownerPath = join(lockDir, "owner.json");
    const competitorOwner = maker("competitor-token");
    const mkdir = fs.mkdir.bind(fs);
    const writeFile = fs.writeFile.bind(fs);
    let lockMkdirCalls = 0;
    let interceptOnce = true;
    t.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
      const [path] = args;
      if (path === lockDir) lockMkdirCalls += 1;
      return mkdir(...args);
    });
    t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
      const [path] = args;
      if (path === ownerPath && interceptOnce) {
        interceptOnce = false;
        await fs.rm(lockDir, { recursive: true, force: true });
        await mkdir(lockDir, { recursive: true });
        await writeFile(ownerPath, competitorOwner, { flag: "wx" });
      }
      return writeFile(...args);
    });
    // deadline=1; the lost owner write is observed at 0, then the first retry
    // reaches the occupied lock at 1 and exhausts the original deadline.
    const clock = [0, 0, 1];
    t.mock.method(Date, "now", () => clock.shift() ?? 1);

    let workRan = false;
    await assert.rejects(
      withFileLock(lockDir, async () => { workRan = true; return 1; }, {
        timeoutMs: 1,
        retryMs: 0,
        staleMs: 5_000,
      }),
      /timed out acquiring file lock/,
    );
    assert.equal(lockMkdirCalls, 2, "EEXIST must retry once before the original deadline expires");
    assert.equal(workRan, false, "work callback must not run under EEXIST");
    // Competitor's lock must have survived (we never rm'd it).
    assert.equal(await fs.readFile(ownerPath, "utf8"), competitorOwner);
    await fs.stat(lockDir); // still exists
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("withFileLock fails closed instead of reaping an observed stale owner", async (t) => {
  const base = await fs.mkdtemp(join(tmpdir(), "flock-stale-"));
  try {
    const lockDir = join(base, "lock");
    const ownerPath = join(lockDir, "owner.json");
    const staleOwner = maker("stale-owner-token", 2_147_483_647);
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(ownerPath, staleOwner, { flag: "wx" });
    await fs.utimes(lockDir, new Date(0), new Date(0));

    let renameCalls = 0;
    let workRan = false;
    const rename = fs.rename.bind(fs);
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      renameCalls += 1;
      return rename(...args);
    });

    await assert.rejects(
      withFileLock(lockDir, async () => {
        workRan = true;
        return "acquired";
      }, { timeoutMs: 0, retryMs: 0, staleMs: 0 }),
      /timed out acquiring file lock/,
    );

    assert.equal(renameCalls, 0, "stale observations must not trigger a destructive rename");
    assert.equal(workRan, false, "work callback must not run after observing a stale owner");
    assert.equal(await fs.readFile(ownerPath, "utf8"), staleOwner);
    await fs.stat(lockDir);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("unexpected owner write errors preserve a replacement owner", async (t) => {
  const base = await fs.mkdtemp(join(tmpdir(), "flock-write-error-"));
  try {
    const lockDir = join(base, "lock");
    const ownerPath = join(lockDir, "owner.json");
    const competitorOwner = maker("write-error-competitor");
    const mkdir = fs.mkdir.bind(fs);
    const writeFile = fs.writeFile.bind(fs);
    let interceptOnce = true;
    let workRan = false;

    t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
      const [path] = args;
      if (path === ownerPath && interceptOnce) {
        interceptOnce = false;
        await fs.rm(lockDir, { recursive: true, force: true });
        await mkdir(lockDir, { recursive: true });
        await writeFile(ownerPath, competitorOwner, { flag: "wx" });
        throw Object.assign(new Error("synthetic owner write failure"), { code: "ENOSPC" });
      }
      return writeFile(...args);
    });

    await assert.rejects(
      withFileLock(lockDir, async () => {
        workRan = true;
      }),
      /synthetic owner write failure/,
    );

    assert.equal(workRan, false);
    assert.equal(await fs.readFile(ownerPath, "utf8"), competitorOwner);
    await fs.stat(lockDir);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
