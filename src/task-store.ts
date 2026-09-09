import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type RouteSelectionMode = "dsh-default" | "manual" | "automatic";
export type RouteVerification = "not-required" | "verified" | "unavailable" | "failed";
export type RouteLaunchStage = "session-created" | "preset-verified" | "launch-failed" | "prompt-sent";

export interface TaskRouteRecord {
  selectionMode: RouteSelectionMode;
  routeRuleId?: string;
  requestedPreset?: string;
  resolvedPreset?: string;
  verification: RouteVerification;
  launchStage: RouteLaunchStage;
  promptSent: boolean;
  failureCode?: string;
  reasonCode?: string;
  recordedAt: string;
}

export interface TaskRecord {
  taskId: string;
  sessionId: string;
  route?: TaskRouteRecord;
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
const ROUTE_KEYS = new Set([
  "failureCode",
  "launchStage",
  "promptSent",
  "reasonCode",
  "recordedAt",
  "requestedPreset",
  "resolvedPreset",
  "routeRuleId",
  "selectionMode",
  "verification",
]);
const SELECTION_MODES = new Set<RouteSelectionMode>(["dsh-default", "manual", "automatic"]);
const VERIFICATION_STATES = new Set<RouteVerification>(["not-required", "verified", "unavailable", "failed"]);
const LAUNCH_STAGES = new Set<RouteLaunchStage>([
  "session-created",
  "preset-verified",
  "launch-failed",
  "prompt-sent",
]);

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
}

function nonEmptyOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  if (!(key in value)) return undefined;
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new TaskStoreError(`invalid task route field ${JSON.stringify(key)}`);
  }
  return candidate;
}

function validateRoute(value: unknown): TaskRouteRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskStoreError("invalid task route record");
  }
  const route = value as Record<string, unknown>;
  if (Object.keys(route).some((key) => !ROUTE_KEYS.has(key))) {
    throw new TaskStoreError("invalid task route record");
  }
  if (
    typeof route.selectionMode !== "string" ||
    !SELECTION_MODES.has(route.selectionMode as RouteSelectionMode) ||
    typeof route.verification !== "string" ||
    !VERIFICATION_STATES.has(route.verification as RouteVerification) ||
    typeof route.launchStage !== "string" ||
    !LAUNCH_STAGES.has(route.launchStage as RouteLaunchStage) ||
    typeof route.promptSent !== "boolean" ||
    typeof route.recordedAt !== "string" ||
    route.recordedAt.trim() === "" ||
    !Number.isFinite(Date.parse(route.recordedAt))
  ) {
    throw new TaskStoreError("invalid task route record");
  }
  const routeRuleId = nonEmptyOptionalString(route, "routeRuleId");
  const requestedPreset = nonEmptyOptionalString(route, "requestedPreset");
  const resolvedPreset = nonEmptyOptionalString(route, "resolvedPreset");
  const failureCode = nonEmptyOptionalString(route, "failureCode");
  const reasonCode = nonEmptyOptionalString(route, "reasonCode");
  if (
    (route.launchStage === "prompt-sent") !== route.promptSent ||
    (route.launchStage === "launch-failed") !== (route.verification === "failed") ||
    (route.launchStage === "launch-failed") !== (failureCode !== undefined)
  ) {
    throw new TaskStoreError("invalid task route state transition snapshot");
  }
  return {
    selectionMode: route.selectionMode as RouteSelectionMode,
    ...(routeRuleId === undefined ? {} : { routeRuleId }),
    ...(requestedPreset === undefined ? {} : { requestedPreset }),
    ...(resolvedPreset === undefined ? {} : { resolvedPreset }),
    verification: route.verification as RouteVerification,
    launchStage: route.launchStage as RouteLaunchStage,
    promptSent: route.promptSent,
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(reasonCode === undefined ? {} : { reasonCode }),
    recordedAt: route.recordedAt,
  };
}

function validateRecord(value: unknown, expectedTaskId: string): TaskRecord {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  const keys = record === undefined ? [] : Object.keys(record).sort();
  if (
    record === undefined ||
    typeof record.taskId !== "string" ||
    record.taskId !== expectedTaskId ||
    !TASK_ID_PATTERN.test(expectedTaskId) ||
    typeof record.sessionId !== "string" ||
    record.sessionId.length === 0 ||
    (keys.join(",") !== "sessionId,taskId" && keys.join(",") !== "route,sessionId,taskId")
  ) {
    throw new TaskStoreError(`invalid dsh-Agentlink task mapping for ${JSON.stringify(expectedTaskId)}`);
  }
  const route = "route" in record ? validateRoute(record.route) : undefined;
  return { taskId: expectedTaskId, sessionId: record.sessionId, ...(route === undefined ? {} : { route }) };
}

function parseRecord(raw: string, expectedTaskId: string): TaskRecord {
  try {
    return validateRecord(JSON.parse(raw), expectedTaskId);
  } catch (error) {
    if (error instanceof TaskStoreError) throw error;
    throw new TaskStoreError(`could not parse dsh-Agentlink task mapping ${JSON.stringify(expectedTaskId)}`, { cause: error });
  }
}

async function readRegularRecordForUpdate(path: string, taskId: string): Promise<TaskRecord> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  if (noFollow !== 0) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, fsConstants.O_RDONLY | noFollow);
      const details = await handle.stat();
      if (!details.isFile()) throw new TaskStoreError(`refusing non-regular dsh-Agentlink task mapping ${JSON.stringify(taskId)}`);
      return parseRecord(await handle.readFile("utf8"), taskId);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") throw new TaskNotFoundError(taskId);
      if (code === "ELOOP") throw new TaskStoreError(`refusing symlinked dsh-Agentlink task mapping ${JSON.stringify(taskId)}`);
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new TaskNotFoundError(taskId);
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new TaskStoreError(`refusing non-regular dsh-Agentlink task mapping ${JSON.stringify(taskId)}`);
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY);
    const opened = await handle.stat();
    if (opened.dev !== details.dev || opened.ino !== details.ino || !opened.isFile()) {
      throw new TaskStoreError(`dsh-Agentlink task mapping changed while opening ${JSON.stringify(taskId)}`);
    }
    return parseRecord(await handle.readFile("utf8"), taskId);
  } finally {
    await handle?.close().catch(() => undefined);
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

  async create(sessionId: string, initialRoute?: TaskRouteRecord): Promise<TaskRecord> {
    if (sessionId.length === 0) throw new TaskStoreError("session id must not be empty");
    const route = initialRoute === undefined ? undefined : validateRoute(initialRoute);
    await mkdir(this.tasksDir, { recursive: true, mode: 0o700 });
    await chmod(this.tasksDir, 0o700);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const taskId = this.generateTaskId();
      const target = this.pathFor(taskId);
      const temp = join(this.tasksDir, `.${taskId}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
      const record: TaskRecord = { taskId, sessionId, ...(route === undefined ? {} : { route }) };
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

  async updateRoute(taskId: string, routeValue: TaskRouteRecord): Promise<TaskRecord> {
    const target = this.pathFor(taskId);
    const route = validateRoute(routeValue);
    const existing = await readRegularRecordForUpdate(target, taskId);
    const record: TaskRecord = { taskId, sessionId: existing.sessionId, route };
    const temp = join(this.tasksDir, `.${taskId}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    let handle;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, target);
      return record;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw error;
    }
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
