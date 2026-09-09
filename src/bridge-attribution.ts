import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "./file-lock.js";

export type CallerModelSource = "caller-reported" | "adapter" | "user-config" | "unknown";

export interface CallerModel {
  provider: string;
  id: string;
  serviceTier?: string | undefined;
  source: CallerModelSource;
}

export interface CallerInfo {
  client: string;
  conversationId?: string | undefined;
  model?: CallerModel | undefined;
}

export interface InvocationRecord {
  runId: string;
  taskId: string;
  rootSessionId: string;
  caller: CallerInfo;
  title?: string | undefined;
  cwd?: string | undefined;
  historical?: boolean | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface SubmissionRecord {
  submissionId: string;
  runId: string;
  taskId: string;
  sessionId: string;
  caller: CallerInfo;
  status: "active" | "finished" | "cancelled" | "failed";
  submittedAt: string;
  closedAt?: string | undefined;
}

interface AttributionSnapshot {
  invocations: InvocationRecord[];
  submissions: SubmissionRecord[];
}

const EMPTY: AttributionSnapshot = { invocations: [], submissions: [] };

function isoNow(): string {
  return new Date().toISOString();
}

function upsertBy<T>(items: T[], item: T, keyOf: (row: T) => string): T[] {
  return [...items.filter((row) => keyOf(row) !== keyOf(item)), item];
}

function parseSnapshot(raw: string): AttributionSnapshot {
  const value = JSON.parse(raw) as Partial<AttributionSnapshot>;
  return {
    invocations: Array.isArray(value.invocations) ? (value.invocations as InvocationRecord[]) : [],
    submissions: Array.isArray(value.submissions) ? (value.submissions as SubmissionRecord[]) : [],
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temp = join(dirname(path), `.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temp, path);
  await chmod(path, 0o600);
}

export class BridgeAttributionStore {
  private readonly path: string;
  private readonly lockDir: string;

  constructor(homeDir: string) {
    const dir = join(homeDir, "attribution");
    this.path = join(dir, "bridge.json");
    this.lockDir = join(dir, "bridge.lock");
  }

  generateRunId(): string {
    return `run_${randomUUID()}`;
  }

  generateSubmissionId(): string {
    return `sub_${randomUUID()}`;
  }

  async snapshot(): Promise<AttributionSnapshot> {
    try {
      return parseSnapshot(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY };
      throw error;
    }
  }

  async task(taskId: string): Promise<InvocationRecord | undefined> {
    return (await this.snapshot()).invocations.find((record) => record.taskId === taskId);
  }


  async registerHistoricalInvocation(input: {
    taskId: string;
    rootSessionId: string;
    caller: CallerInfo;
    runId?: string | undefined;
  }): Promise<InvocationRecord> {
    const now = isoNow();
    const existing = await this.task(input.taskId);
    if (existing !== undefined) return existing;
    const invocation: InvocationRecord = {
      runId: input.runId ?? this.generateRunId(),
      taskId: input.taskId,
      rootSessionId: input.rootSessionId,
      caller: input.caller,
      historical: true,
      createdAt: now,
      updatedAt: now,
    };
    await this.update((snapshot) => ({
      ...snapshot,
      invocations: upsertBy(snapshot.invocations, invocation, (record) => record.taskId),
    }));
    return invocation;
  }

  async registerInvocation(input: {
    runId: string;
    taskId: string;
    rootSessionId: string;
    caller: CallerInfo;
    title?: string | undefined;
    cwd?: string | undefined;
    submissionId?: string | undefined;
    submittedAt?: string | undefined;
  }): Promise<{ invocation: InvocationRecord; submission: SubmissionRecord }> {
    const now = input.submittedAt ?? isoNow();
    const invocation: InvocationRecord = {
      runId: input.runId,
      taskId: input.taskId,
      rootSessionId: input.rootSessionId,
      caller: input.caller,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      createdAt: now,
      updatedAt: now,
    };
    const submission: SubmissionRecord = {
      submissionId: input.submissionId ?? this.generateSubmissionId(),
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.rootSessionId,
      caller: input.caller,
      status: "active",
      submittedAt: now,
    };
    await this.update((snapshot) => ({
      invocations: upsertBy(snapshot.invocations, invocation, (record) => record.taskId),
      submissions: upsertBy(snapshot.submissions, submission, (record) => record.submissionId),
    }));
    return { invocation, submission };
  }

  async registerSubmission(input: {
    runId: string;
    taskId: string;
    sessionId: string;
    caller: CallerInfo;
    submissionId?: string | undefined;
    submittedAt?: string | undefined;
  }): Promise<SubmissionRecord> {
    const submission: SubmissionRecord = {
      submissionId: input.submissionId ?? this.generateSubmissionId(),
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      caller: input.caller,
      status: "active",
      submittedAt: input.submittedAt ?? isoNow(),
    };
    await this.update((snapshot) => ({
      ...snapshot,
      submissions: upsertBy(snapshot.submissions, submission, (record) => record.submissionId),
    }));
    return submission;
  }

  async activeSubmission(taskId: string): Promise<SubmissionRecord | undefined> {
    return (await this.snapshot()).submissions
      .filter((record) => record.taskId === taskId && record.status === "active")
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
  }

  async closeSubmission(
    submissionId: string,
    status: "finished" | "cancelled" | "failed" = "finished",
  ): Promise<SubmissionRecord | undefined> {
    let closed: SubmissionRecord | undefined;
    await this.update((snapshot) => {
      const submissions = snapshot.submissions.map((record) => {
        if (record.submissionId !== submissionId || record.status !== "active") return record;
        closed = { ...record, status, closedAt: isoNow() };
        return closed;
      });
      return { ...snapshot, submissions };
    });
    return closed;
  }

  private async update(mutator: (snapshot: AttributionSnapshot) => AttributionSnapshot): Promise<void> {
    await mkdir(dirname(this.lockDir), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.lockDir), 0o700);
    await withFileLock(this.lockDir, async () => {
      await writeJson(this.path, mutator(await this.snapshot()));
    });
  }
}
