import { chmod, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { withFileLock } from "./file-lock.js";

export type WorkspaceClaimMode = "read-only" | "exclusive-write";

export interface WorkspaceClaim {
  cwd: string;
  taskId: string;
  sessionId: string;
  mode: WorkspaceClaimMode;
  createdAt: string;
}

export interface WorkspaceClaimAcquireInput {
  canonicalCwd: string;
  taskId: string;
  sessionId: string;
  mode: WorkspaceClaimMode;
}

export class WorkspaceClaimConflictError extends Error {
  constructor(
    readonly code: "stale_view" | "workspace_conflict",
    message: string,
    readonly details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceClaimConflictError";
  }
}

const TASK_ID_PATTERN = /^dsh_[a-f0-9]{12}$/;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function requireTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new WorkspaceClaimConflictError("stale_view", `invalid task id ${JSON.stringify(taskId)}`);
  }
}

function requireMode(mode: string): WorkspaceClaimMode {
  if (mode !== "read-only" && mode !== "exclusive-write") {
    throw new WorkspaceClaimConflictError("stale_view", `invalid workspace claim mode ${JSON.stringify(mode)}`);
  }
  return mode;
}

function canonicalPath(cwd: string): string {
  if (cwd.length === 0 || !isAbsolute(cwd)) {
    throw new WorkspaceClaimConflictError("stale_view", `canonical cwd must be an absolute path: ${JSON.stringify(cwd)}`);
  }
  return resolve(cwd);
}

function parseClaim(raw: string, expectedTaskId: string, path: string): WorkspaceClaim {
  try {
    const value = asObject(JSON.parse(raw));
    const keys = value === undefined ? [] : Object.keys(value).sort();
    if (
      value === undefined ||
      typeof value.cwd !== "string" ||
      typeof value.taskId !== "string" ||
      value.taskId !== expectedTaskId ||
      typeof value.sessionId !== "string" ||
      value.sessionId.length === 0 ||
      typeof value.mode !== "string" ||
      typeof value.createdAt !== "string" ||
      Number.isNaN(Date.parse(value.createdAt)) ||
      keys.length !== 5 ||
      keys[0] !== "createdAt" ||
      keys[1] !== "cwd" ||
      keys[2] !== "mode" ||
      keys[3] !== "sessionId" ||
      keys[4] !== "taskId"
    ) {
      throw new WorkspaceClaimConflictError("stale_view", `invalid workspace claim in ${path}`);
    }
    return {
      cwd: canonicalPath(value.cwd),
      taskId: expectedTaskId,
      sessionId: value.sessionId,
      mode: requireMode(value.mode),
      createdAt: value.createdAt,
    };
  } catch (error) {
    if (error instanceof WorkspaceClaimConflictError) throw error;
    throw new WorkspaceClaimConflictError("stale_view", `could not parse workspace claim in ${path}`, {}, { cause: error });
  }
}

function overlaps(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  if (leftToRight === "" || (!leftToRight.startsWith("..") && !isAbsolute(leftToRight))) return true;
  const rightToLeft = relative(right, left);
  return rightToLeft === "" || (!rightToLeft.startsWith("..") && !isAbsolute(rightToLeft));
}

function conflicts(candidate: WorkspaceClaim, existing: WorkspaceClaim): boolean {
  if (!overlaps(candidate.cwd, existing.cwd)) return false;
  return candidate.mode === "exclusive-write" || existing.mode === "exclusive-write";
}

function cloneClaim(claim: WorkspaceClaim): WorkspaceClaim {
  return { ...claim };
}

export class WorkspaceClaimStore {
  private readonly claimsDir: string;

  constructor(homeDir: string) {
    this.claimsDir = join(homeDir, "claims");
  }

  async acquire(input: WorkspaceClaimAcquireInput): Promise<WorkspaceClaim> {
    requireTaskId(input.taskId);
    if (input.sessionId.length === 0) {
      throw new WorkspaceClaimConflictError("stale_view", "session id must not be empty");
    }
    const claim: WorkspaceClaim = {
      cwd: canonicalPath(input.canonicalCwd),
      taskId: input.taskId,
      sessionId: input.sessionId,
      mode: requireMode(input.mode),
      createdAt: new Date().toISOString(),
    };

    return this.withRegistryLock(async () => {
      const claims = await this.readAllClaims();
      const existingForTask = claims.find((existing) => existing.taskId === claim.taskId);
      if (existingForTask !== undefined) {
        throw new WorkspaceClaimConflictError("stale_view", `workspace claim already exists for task ${claim.taskId}`, {
          existing: cloneClaim(existingForTask),
        });
      }

      const conflict = claims.find((existing) => conflicts(claim, existing));
      if (conflict !== undefined) {
        throw new WorkspaceClaimConflictError("workspace_conflict", `workspace claim conflicts with task ${conflict.taskId}`, {
          requested: cloneClaim(claim),
          existing: cloneClaim(conflict),
        });
      }

      await writeFile(this.pathFor(claim.taskId), `${JSON.stringify(claim, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(this.pathFor(claim.taskId), 0o600);
      return cloneClaim(claim);
    });
  }

  async release(taskId: string): Promise<WorkspaceClaim> {
    requireTaskId(taskId);
    return this.withRegistryLock(async () => {
      const claim = await this.readClaim(taskId);
      if (claim === undefined) {
        throw new WorkspaceClaimConflictError("stale_view", `workspace claim does not exist for task ${taskId}`);
      }
      await unlink(this.pathFor(taskId));
      return cloneClaim(claim);
    });
  }

  async get(taskId: string): Promise<WorkspaceClaim | undefined> {
    requireTaskId(taskId);
    return this.withRegistryLock(async () => {
      const claim = await this.readClaim(taskId);
      return claim === undefined ? undefined : cloneClaim(claim);
    });
  }

  async list(): Promise<WorkspaceClaim[]> {
    return this.withRegistryLock(async () => (await this.readAllClaims()).map(cloneClaim));
  }

  private async withRegistryLock<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(this.claimsDir, { recursive: true, mode: 0o700 });
    await chmod(this.claimsDir, 0o700);
    return withFileLock(join(this.claimsDir, "registry.lock"), work);
  }

  private async readAllClaims(): Promise<WorkspaceClaim[]> {
    let names: string[];
    try {
      names = await readdir(this.claimsDir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    const taskIds = names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();
    return Promise.all(
      taskIds.map(async (taskId) => parseClaim(await readFile(this.pathFor(taskId), "utf8"), taskId, this.pathFor(taskId))),
    );
  }

  private async readClaim(taskId: string): Promise<WorkspaceClaim | undefined> {
    try {
      return parseClaim(await readFile(this.pathFor(taskId), "utf8"), taskId, this.pathFor(taskId));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
  }

  private pathFor(taskId: string): string {
    requireTaskId(taskId);
    return join(this.claimsDir, `${taskId}.json`);
  }
}
