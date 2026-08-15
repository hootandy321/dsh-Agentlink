import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { withFileLock } from "../src/file-lock.js";

const maker = (token: string) =>
  JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() });

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
    const clock = [0, 0, 0, 1];
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

test("isStaleLock does not delete a new competitor lock after an old stat reports ENOENT", async (t) => {
  const base = await fs.mkdtemp(join(tmpdir(), "flock-obs-"));
  try {
    const lockDir = join(base, "lock");
    const ownerPath = join(lockDir, "owner.json");
    const competitorOwner = maker("new-competitor-token");
    // Pre-create the lock so the first mkdir returns EEXIST and drives us into
    // isStaleLock with an observation of the old lock.
    await fs.mkdir(lockDir, { recursive: true });

    const stat = fs.stat.bind(fs);
    let interceptOnce = true;
    let workRan = false;
    t.mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
      const [path] = args;
      if (path === lockDir && interceptOnce) {
        interceptOnce = false;
        // The old lock disappears after mkdir observed EEXIST, then a new competitor
        // acquires the same path before stat's old ENOENT result is delivered.
        await fs.rm(lockDir, { recursive: true, force: true });
        await fs.mkdir(lockDir, { recursive: true });
        await fs.writeFile(ownerPath, competitorOwner, { flag: "wx" });
        throw Object.assign(new Error("synthetic stale stat observation"), { code: "ENOENT" });
      }
      return stat(...args);
    });

    await assert.rejects(
      withFileLock(lockDir, async () => {
        workRan = true;
        return "acquired";
      }, { timeoutMs: 0, retryMs: 0, staleMs: 5_000 }),
      /timed out acquiring file lock/,
    );

    assert.equal(workRan, false, "work callback must not run under the competitor's lock");
    assert.equal(await fs.readFile(ownerPath, "utf8"), competitorOwner);
    await fs.stat(lockDir);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
