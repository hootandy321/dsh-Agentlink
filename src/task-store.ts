import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface TaskRecord {
  taskId: string;
  sessionId: string;
}

export class TaskStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskStoreError";
  }
}

export class TaskNotFoundError extends TaskStoreError {
  constructor(readonly taskId: string) {
    super(`DSH task ${JSON.stringify(taskId)} does not exist`);
    this.name = "TaskNotFoundError";
  }
}

const TASK_ID_PATTERN = /^dsh_[a-f0-9]{12}$/;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
}

function validateRecord(value: unknown, expectedTaskId: string): TaskRecord {
  const keys =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.keys(value as Record<string, unknown>).sort()
      : [];
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).taskId !== "string" ||
    (value as Record<string, unknown>).taskId !== expectedTaskId ||
    !TASK_ID_PATTERN.test(expectedTaskId) ||
    typeof (value as Record<string, unknown>).sessionId !== "string" ||
    ((value as Record<string, unknown>).sessionId as string).length === 0 ||
    keys.length !== 2 ||
    keys[0] !== "sessionId" ||
    keys[1] !== "taskId"
  ) {
    throw new TaskStoreError(`invalid codex-dsh task mapping for ${JSON.stringify(expectedTaskId)}`);
  }
  return { taskId: expectedTaskId, sessionId: (value as Record<string, unknown>).sessionId as string };
}

function parseRecord(raw: string, expectedTaskId: string): TaskRecord {
  try {
    return validateRecord(JSON.parse(raw), expectedTaskId);
  } catch (error) {
    if (error instanceof TaskStoreError) throw error;
    throw new TaskStoreError(`could not parse codex-dsh task mapping ${JSON.stringify(expectedTaskId)}`, { cause: error });
  }
}

export class TaskStore {
  private readonly tasksDir: string;

  constructor(homeDir: string) {
    this.tasksDir = join(homeDir, "tasks");
  }

  generateTaskId(): string {
    return `dsh_${randomBytes(6).toString("hex")}`;
  }

  async create(sessionId: string): Promise<TaskRecord> {
    if (sessionId.length === 0) throw new TaskStoreError("session id must not be empty");
    await mkdir(this.tasksDir, { recursive: true, mode: 0o700 });
    await chmod(this.tasksDir, 0o700);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const taskId = this.generateTaskId();
      const target = this.pathFor(taskId);
      const temp = join(this.tasksDir, `.${taskId}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
      const record: TaskRecord = { taskId, sessionId };
      try {
        await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await link(temp, target);
        await unlink(temp).catch(() => undefined);
        return record;
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    throw new TaskStoreError("could not allocate a unique DSH task id");
  }

  async get(taskId: string): Promise<TaskRecord> {
    let raw: string;
    try {
      raw = await readFile(this.pathFor(taskId), "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") throw new TaskNotFoundError(taskId);
      throw error;
    }
    return parseRecord(raw, taskId);
  }

  async list(): Promise<TaskRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.tasksDir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    const taskIds = names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();
    return Promise.all(
      taskIds.map(async (taskId) => parseRecord(await readFile(this.pathFor(taskId), "utf8"), taskId)),
    );
  }

  private pathFor(taskId: string): string {
    if (!TASK_ID_PATTERN.test(taskId)) throw new TaskStoreError(`invalid task id ${JSON.stringify(taskId)}`);
    return join(this.tasksDir, `${taskId}.json`);
  }
}
