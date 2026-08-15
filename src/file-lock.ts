import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";

// This lock is for short critical sections on one local filesystem. It has no
// heartbeat and deliberately does not auto-reap stale paths: an mtime/PID
// observation cannot be atomically coupled to a later rename, and those
// observations are not reliable on network filesystems. A hard-killed owner
// can therefore leave a fail-closed directory that requires operator cleanup.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
}

function lockTimeoutError(lockDir: string): Error {
  return new Error(
    `timed out acquiring file lock ${lockDir}. Run "npm run doctor" to inspect fail-closed locks; see KNOWN_ISSUES.md and verify the exact path before any manual cleanup.`,
  );
}

export async function withFileLock<T>(
  lockDir: string,
  work: () => Promise<T>,
  options: {
    timeoutMs?: number;
    retryMs?: number;
    // Retained for caller compatibility. Automatic stale reaping is disabled
    // until it can use a primitive with atomic compare-and-delete semantics.
    staleMs?: number;
  } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryMs = options.retryMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  const ownerPath = join(lockDir, "owner.json");

  while (true) {
    try {
      await fs.mkdir(lockDir, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw lockTimeoutError(lockDir);
      await sleep(retryMs);
      continue;
    }

    try {
      await fs.writeFile(ownerPath, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), {
        mode: 0o600,
        flag: "wx",
      });
      break;
    } catch (error) {
      const code = errorCode(error);
      // ENOENT (competitor removed the dir) and EEXIST (competitor replaced it with
      // their own lock) both mean this attempt already lost the race. Retry within
      // the original deadline and never rm the current lockDir, which may now belong
      // to the competitor. Any other error is unexpected: fail closed and throw without
      // touching the current path.
      if (code === "ENOENT" || code === "EEXIST") {
        if (Date.now() >= deadline) throw lockTimeoutError(lockDir);
        await sleep(retryMs);
        continue;
      }
      // We have not written our token, so we cannot prove the current path is
      // still our own mkdir attempt. A competitor may have replaced lockDir
      // with an empty directory and not yet written its owner.json; rmdir
      // would delete that live in-progress lock. So we fail closed and never
      // remove an unverified current path. The trade-off is that an unexpected
      // owner-write failure can leave our own empty attempt behind (when no
      // competitor raced us), which later acquisitions see as EEXIST and time
      // out on until operator cleanup — the safe direction, because deleting
      // an unverified path is the destructive choice.
      throw error;
    }
  }

  try {
    return await work();
  } finally {
    const owner = await readOwner(ownerPath);
    if (owner?.token === token) await fs.rm(lockDir, { recursive: true, force: true });
  }
}

async function readOwner(ownerPath: string): Promise<{ pid?: number; token?: string } | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(ownerPath, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const owner = value as Record<string, unknown>;
    return {
      ...(typeof owner.pid === "number" && Number.isInteger(owner.pid) ? { pid: owner.pid } : {}),
      ...(typeof owner.token === "string" ? { token: owner.token } : {}),
    };
  } catch {
    return undefined;
  }
}
