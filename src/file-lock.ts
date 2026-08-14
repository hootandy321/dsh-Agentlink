import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
}

export async function withFileLock<T>(
  lockDir: string,
  work: () => Promise<T>,
  options: { timeoutMs?: number; retryMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryMs = options.retryMs ?? 10;
  const staleMs = options.staleMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  const ownerPath = join(lockDir, "owner.json");

  while (true) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (await isStaleLock(lockDir, ownerPath, staleMs)) {
        const stalePath = `${lockDir}.stale.${process.pid}.${randomUUID()}`;
        try {
          await rename(lockDir, stalePath);
          await rm(stalePath, { recursive: true, force: true });
          continue;
        } catch (staleError) {
          if (errorCode(staleError) !== "ENOENT") throw staleError;
        }
      }
      if (Date.now() >= deadline) throw new Error(`timed out acquiring file lock ${lockDir}`);
      await sleep(retryMs);
      continue;
    }

    try {
      await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), {
        mode: 0o600,
        flag: "wx",
      });
      break;
    } catch (error) {
      await rm(lockDir, { recursive: true, force: true });
      throw error;
    }
  }

  try {
    return await work();
  } finally {
    const owner = await readOwner(ownerPath);
    if (owner?.token === token) await rm(lockDir, { recursive: true, force: true });
  }
}

async function readOwner(ownerPath: string): Promise<{ pid?: number; token?: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(ownerPath, "utf8")) as unknown;
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

function processIsAlive(pid: number | undefined): boolean {
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function isStaleLock(lockDir: string, ownerPath: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(lockDir);
    if (Date.now() - info.mtimeMs < staleMs) return false;
    return !processIsAlive((await readOwner(ownerPath))?.pid);
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}
