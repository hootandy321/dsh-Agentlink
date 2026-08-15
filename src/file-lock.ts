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
      if (Date.now() >= deadline) throw new Error(`timed out acquiring file lock ${lockDir}`);
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
      // to the competitor. Any other error is unexpected: clean up our attempt and throw.
      if (code === "ENOENT" || code === "EEXIST") {
        if (Date.now() >= deadline) throw new Error(`timed out acquiring file lock ${lockDir}`);
        await sleep(retryMs);
        continue;
      }
      // We have not written our token, so we cannot prove ownership of the
      // current path. rmdir can clean up only our still-empty attempt; if a
      // competitor has installed owner.json it fails closed and preserves it.
      await fs.rmdir(lockDir).catch(() => undefined);
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
