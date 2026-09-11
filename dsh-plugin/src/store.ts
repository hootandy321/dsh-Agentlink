import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import {
  OFFICIAL_PRICE_CATALOG,
  aggregateAllPluginCost,
  aggregateRunCost,
  aggregateSessionCost,
  type AggregateCost,
  mergePriceCatalogs,
  type PriceCatalog,
  type UsageRequestRecord
} from "./cost-core/index.js";
import type {
  AgentlinkSummary,
  AttachSessionInput,
  CloseSubmissionInput,
  DetailsInput,
  ListRunsInput,
  SessionsInput,
  SessionListRecord,
  PluginConfig,
  PriceRate,
  RegisterSubmissionInput,
  SubagentAddress,
  RegisterInvocationInput,
  RegisterInvocationResult,
  RunListItem,
  RunRecord,
  SessionRecord,
  SubmissionRecord,
  TaskRecord,
  SummaryInput,
  UsageRecord
} from "./types.js";
import { normalizeCallerModelId, toCoreCaller } from "./types.js";
import {
  attachSessionInputSchema,
  closeSubmissionInputSchema,
  detailsInputSchema,
  listRunsInputSchema,
  priceRateSchema,
  registerInvocationInputSchema,
  registerSubmissionInputSchema,
  runRecordSchema,
  sessionRecordSchema,
  submissionRecordSchema,
  summaryInputSchema,
  sessionsInputSchema,
  subagentAddressSchema,
  taskRecordSchema,
  usageRecordSchema
} from "./schemas.js";

export const agentlinkDomain = defineDomain({
  name: "agentlink",
  version: 2,
  compatibleVersions: [1],
  invalidRecords: "backup-and-skip",
  tables: {
    runs: domainTable<string, RunRecord>(runRecordSchema),
    tasks: domainTable<string, TaskRecord>(taskRecordSchema),
    sessions: domainTable<string, SessionRecord>(sessionRecordSchema),
    submissions: domainTable<string, SubmissionRecord>(submissionRecordSchema),
    usage: domainTable<string, UsageRecord>(usageRecordSchema),
    prices: domainTable<string, PriceRate>(priceRateSchema)
  }
});

export interface KeyValueTable<T> {
  get(key: string): T | undefined;
  put(key: string, value: T): void | Promise<void>;
  entries(): Iterable<[string, T]>;
}

export interface AgentlinkTables {
  runs: KeyValueTable<RunRecord>;
  tasks: KeyValueTable<TaskRecord>;
  sessions: KeyValueTable<SessionRecord>;
  submissions: KeyValueTable<SubmissionRecord>;
  usage: KeyValueTable<UsageRecord>;
  prices: KeyValueTable<PriceRate>;
}

export class MemoryTable<T> implements KeyValueTable<T> {
  private readonly values = new Map<string, T>();

  get(key: string): T | undefined {
    return this.values.get(key);
  }

  put(key: string, value: T): void {
    this.values.set(key, value);
  }

  entries(): Iterable<[string, T]> {
    return this.values.entries();
  }
}

export function memoryTables(): AgentlinkTables {
  return {
    runs: new MemoryTable(),
    tasks: new MemoryTable(),
    sessions: new MemoryTable(),
    submissions: new MemoryTable(),
    usage: new MemoryTable(),
    prices: new MemoryTable()
  };
}

export class AgentlinkStore {
  private collectorErrorCount = 0;
  private readonly pendingChildren = new Map<string, RuntimeSessionLike[]>();
  private attributionWrite: Promise<void> = Promise.resolve();
  private readonly catalog: PriceCatalog;

  constructor(
    private readonly tables: AgentlinkTables,
    private readonly now: () => Date = () => new Date(),
    config: PluginConfig = {},
    private readonly storageMode: "persistent" | "memory" = "persistent"
  ) {
    this.catalog = mergePriceCatalogs(OFFICIAL_PRICE_CATALOG, { entries: config.prices ?? [] });
    for (const price of this.catalog.entries) {
      const id = price.priceId;
      if (this.tables.prices.get(id) === undefined) void this.tables.prices.put(id, price);
    }
  }

  async registerInvocation(raw: RegisterInvocationInput): Promise<RegisterInvocationResult> {
    const input = registerInvocationInputSchema.parse(raw) as RegisterInvocationInput;
    const runId = input.runId ?? randomId("run");
    const result = await this.withAttributionWrite(() => this.registerInvocationLocked(input, runId));
    await this.attachPendingChildren(input.rootSessionId);
    return result;
  }

  private async registerInvocationLocked(input: RegisterInvocationInput, runId: string): Promise<RegisterInvocationResult> {
    const now = input.submittedAt ?? this.now().toISOString();
    const knownTask = this.tables.tasks.get(input.taskId);
    const knownSession = this.tables.sessions.get(input.rootSessionId);
    if (knownTask && (knownTask.runId !== runId || knownTask.rootSessionId !== input.rootSessionId)) throw new Error("task attribution already registered with another run or root");
    if (knownSession && (knownSession.runId !== runId || knownSession.taskId !== input.taskId)) throw new Error("session attribution already registered with another run or task");
    const existing = this.tables.runs.get(runId);
    const run: RunRecord = runRecordSchema.parse({
      runId,
      taskIds: appendUnique(existing?.taskIds, input.taskId),
      rootSessionIds: appendUnique(existing?.rootSessionIds, input.rootSessionId),
      ...(existing?.title ?? input.title ? { title: existing?.title ?? input.title } : {}),
      ...(existing?.cwd ?? input.cwd ? { cwd: existing?.cwd ?? input.cwd } : {}),
      caller: existing?.caller ?? normalizeCaller(input.caller),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
    await this.tables.runs.put(runId, run);
    await this.tables.tasks.put(input.taskId, taskRecordSchema.parse({
      taskId: input.taskId,
      runId,
      rootSessionId: input.rootSessionId,
      createdAt: this.tables.tasks.get(input.taskId)?.createdAt ?? now,
      updatedAt: now
    }));
    await this.attachSessionLocked({
      runId,
      taskId: input.taskId,
      sessionId: input.rootSessionId,
      rootSessionId: input.rootSessionId,
      origin: "delegated",
      attachedAt: now
    });
    if (input.historical === true) {
      return { runId, taskId: input.taskId, rootSessionId: input.rootSessionId, registered: true };
    }
    const submission = await this.registerSubmission({
      runId,
      taskId: input.taskId,
      sessionId: input.rootSessionId,
      caller: normalizeCaller(input.caller),
      submittedAt: now,
      closeMode: input.closeMode ?? "turn-end"
    });
    return { runId, taskId: input.taskId, rootSessionId: input.rootSessionId, submissionId: submission.submissionId, registered: true };
  }

  async registerSubmission(raw: RegisterSubmissionInput): Promise<SubmissionRecord> {
    const input = registerSubmissionInputSchema.parse(raw) as RegisterSubmissionInput;
    const session = this.tables.sessions.get(input.sessionId);
    if (!session || session.runId !== input.runId || session.taskId !== input.taskId) throw new Error("submission does not match a registered session");
    const now = input.submittedAt ?? this.now().toISOString();
    const submission: SubmissionRecord = submissionRecordSchema.parse({
      submissionId: randomId("sub"),
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      caller: normalizeCaller(input.caller),
      status: "active",
      closeMode: input.closeMode ?? "turn-end",
      submittedAt: now
    });
    await this.tables.submissions.put(submission.submissionId, submission);
    return submission;
  }

  async closeSubmission(raw: CloseSubmissionInput): Promise<SubmissionRecord | undefined> {
    const input = closeSubmissionInputSchema.parse(raw) as CloseSubmissionInput;
    const current = this.tables.submissions.get(input.submissionId);
    if (current === undefined) return undefined;
    const next: SubmissionRecord = submissionRecordSchema.parse({
      ...current,
      status: input.status ?? "finished",
      closedAt: input.closedAt ?? this.now().toISOString()
    });
    await this.tables.submissions.put(next.submissionId, next);
    return next;
  }

  async closeTurnSubmissions(sessionId: string, closedAt = this.now().toISOString()): Promise<SubmissionRecord[]> {
    const closed: SubmissionRecord[] = [];
    const session = this.tables.sessions.get(sessionId);
    if (session?.inheritedSubmissionId !== undefined) {
      await this.tables.sessions.put(sessionId, sessionRecordSchema.parse({ ...session, inheritedSubmissionId: undefined, updatedAt: closedAt }));
    }
    for (const [, submission] of this.tables.submissions.entries()) {
      if (submission.sessionId !== sessionId || submission.status !== "active" || submission.closeMode === "manual") continue;
      const next: SubmissionRecord = submissionRecordSchema.parse({ ...submission, status: "finished", closedAt });
      await this.tables.submissions.put(next.submissionId, next);
      closed.push(next);
    }
    return closed;
  }

  async attachSession(raw: AttachSessionInput): Promise<SessionRecord> {
    const input = attachSessionInputSchema.parse(raw) as AttachSessionInput;
    return this.withAttributionWrite(() => this.attachSessionLocked(input));
  }

  private async attachSessionLocked(input: AttachSessionInput): Promise<SessionRecord> {
    const now = input.attachedAt ?? this.now().toISOString();
    const existing = this.tables.sessions.get(input.sessionId);
    const task = this.tables.tasks.get(input.taskId);
    if (!task || task.runId !== input.runId) throw new Error("session does not match a registered task");
    if (existing && (existing.runId !== input.runId || existing.taskId !== input.taskId)) throw new Error("session attribution already registered with another run or task");
    const rootSessionId = input.rootSessionId ?? existing?.rootSessionId ?? this.tables.tasks.get(input.taskId)?.rootSessionId;
    const session: SessionRecord = sessionRecordSchema.parse({
      sessionId: input.sessionId,
      runId: input.runId,
      taskId: input.taskId,
      ...(rootSessionId === undefined ? {} : { rootSessionId }),
      ...(input.parentSessionId ?? existing?.parentSessionId ? { parentSessionId: input.parentSessionId ?? existing?.parentSessionId } : {}),
      ...(input.inheritedSubmissionId ?? existing?.inheritedSubmissionId ? { inheritedSubmissionId: input.inheritedSubmissionId ?? existing?.inheritedSubmissionId } : {}),
      origin: input.origin ?? existing?.origin ?? "delegated",
      ...(input.inheritedEventCount ?? existing?.inheritedEventCount !== undefined ? { inheritedEventCount: input.inheritedEventCount ?? existing?.inheritedEventCount } : {}),
      ...(input.firstLiveSeq ?? existing?.firstLiveSeq !== undefined ? { firstLiveSeq: input.firstLiveSeq ?? existing?.firstLiveSeq } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
    await this.tables.sessions.put(input.sessionId, session);
    const run = this.tables.runs.get(input.runId);
    if (run !== undefined) {
      await this.tables.runs.put(input.runId, runRecordSchema.parse({
        ...run,
        taskIds: appendUnique(run.taskIds, input.taskId),
        ...(rootSessionId === undefined ? {} : { rootSessionIds: appendUnique(run.rootSessionIds, rootSessionId) }),
        updatedAt: now
      }));
    }
    return session;
  }

  async attachChildSessionFromRuntime(child: RuntimeSessionLike): Promise<SessionRecord | undefined> {
    const childId = stringOf(child.id);
    if (childId === undefined) return undefined;
    const header = child.header ?? {};
    const parentSessionId = stringOf(header.parentSession);
    if (parentSessionId === undefined) return undefined;
    const parent = this.tables.sessions.get(parentSessionId);
    if (parent === undefined) {
      const list = this.pendingChildren.get(parentSessionId) ?? [];
      if (!list.some((item) => stringOf(item.id) === childId)) this.pendingChildren.set(parentSessionId, [...list, child]);
      return undefined;
    }
    return this.attachSession({
      runId: parent.runId,
      taskId: parent.taskId,
      sessionId: childId,
      rootSessionId: parent.rootSessionId ?? parent.sessionId,
      parentSessionId,
      inheritedSubmissionId: this.activeSubmissionFor(parentSessionId, this.now().toISOString())?.submissionId,
      origin: header.origin === "subagent" ? "dsh-internal" : parent.origin,
      inheritedEventCount: numberOf(child.inheritedEventCount),
      firstLiveSeq: numberOf(child.firstLiveSeq),
      attachedAt: this.now().toISOString()
    });
  }

  async recordUsage(raw: UsageRecord): Promise<void> {
    const record = usageRecordSchema.parse(raw) as UsageRecord;
    const session = record.sessionId === undefined ? undefined : this.tables.sessions.get(record.sessionId);
    const submission = record.submissionId === undefined ? undefined : this.tables.submissions.get(record.submissionId);
    const caller = record.caller ?? submission?.caller;
    const origin = caller === undefined ? "manual-dsh" : record.origin;
    const enriched: UsageRecord = usageRecordSchema.parse({
      ...record,
      runId: record.runId ?? session?.runId,
      taskId: record.taskId ?? session?.taskId,
      submissionId: record.submissionId ?? submission?.submissionId,
      caller,
      origin,
      ...(record.firstLiveSeq ?? session?.firstLiveSeq !== undefined ? { firstLiveSeq: record.firstLiveSeq ?? session?.firstLiveSeq } : {})
    });
    await this.tables.usage.put(record.requestRecordId, enriched);
  }

  attributionFor(sessionId: string | undefined, startedAt: string): Pick<UsageRecord, "runId" | "taskId" | "submissionId" | "caller" | "firstLiveSeq"> {
    const session = sessionId === undefined ? undefined : this.tables.sessions.get(sessionId);
    const submission = this.activeSubmissionFor(sessionId, startedAt) ?? inheritedSubmissionFor(session, this.tables.submissions);
    return {
      runId: session?.runId,
      taskId: session?.taskId,
      submissionId: submission?.submissionId,
      caller: submission?.caller,
      firstLiveSeq: session?.firstLiveSeq
    };
  }

  markCollectorError(): void {
    this.collectorErrorCount += 1;
  }

  listRuns(raw: ListRunsInput = {}): RunListItem[] {
    const input = listRunsInputSchema.parse(raw) as ListRunsInput;
    const limit = clampLimit(input.limit, 50);
    return [...this.tables.runs.entries()]
      .map(([, run]) => {
        const sessions = this.sessionsForRun(run.runId);
        const usage = this.usageForRun(run.runId);
        return {
          runId: run.runId,
          taskId: run.taskIds[0] ?? "",
          rootSessionId: run.rootSessionIds[0] ?? "",
          title: run.title,
          cwd: run.cwd,
          caller: run.caller,
          sessionCount: sessions.length,
          requestCount: usage.length,
          updatedAt: run.updatedAt
        };
      })
      .filter((run) => input.callerClient === undefined || run.caller.client === input.callerClient)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  summary(raw: SummaryInput = {}): AgentlinkSummary {
    const input = summaryInputSchema.parse(raw) as SummaryInput;
    const session = input.sessionId === undefined ? undefined : this.tables.sessions.get(input.sessionId);
    const runId = input.runId ?? session?.runId;
    const run = runId === undefined ? undefined : this.tables.runs.get(runId);
    const records = this.coreUsageRecords();
    const items: AgentlinkSummary["items"] = [];

    if (input.sessionId !== undefined) {
      items.push({ scope: "session", label: "This session", aggregate: compactAggregate(aggregateSessionCost(input.sessionId, records, this.catalog)) });
    }
    if (runId !== undefined) {
      const sessionCount = this.sessionsForRun(runId).length;
      items.push({ scope: "run", label: `This task · ${sessionCount} sessions`, aggregate: compactAggregate(aggregateRunCost(runId, records, this.catalog)) });
    }
    items.push({ scope: "all", label: "Plugin total · this Host", aggregate: compactAggregate(aggregateAllPluginCost(records, this.catalog)) });

    const notes: string[] = [];
    if (run === undefined && input.sessionId !== undefined) notes.push("non-agentlink-session");
    if (items.some((item) => item.aggregate.partial)) notes.push("partial-estimate");
    if (this.collectorErrorCount > 0) notes.push("collector-errors");
    if (this.storageMode === "memory") notes.push("storage-memory-fallback");

    return {
      sessionId: input.sessionId,
      runId,
      caller: run?.caller,
      generatedAt: this.now().toISOString(),
      items,
      notes
    };
  }

  details(raw: DetailsInput = {}): UsageRecord[] {
    const input = detailsInputSchema.parse(raw) as DetailsInput;
    const limit = clampLimit(input.limit, 100);
    const usage = input.sessionId !== undefined
      ? this.usageForSessions([input.sessionId])
      : input.runId !== undefined
        ? this.usageForRun(input.runId)
        : [...this.tables.usage.entries()].map(([, record]) => record);
    return usage.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  sessions(raw: SessionsInput, subagentAddressFor?: (sessionId: string) => SubagentAddress | undefined): SessionListRecord[] {
    const input = sessionsInputSchema.parse(raw) as SessionsInput;
    return this.sessionsForRun(input.runId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, clampLimit(input.limit, 100))
      .map(({ sessionId, runId, taskId, rootSessionId, parentSessionId, origin, createdAt, updatedAt }) => {
        const candidate = origin === "dsh-internal" ? subagentAddressFor?.(sessionId) : undefined;
        const subagentAddress = candidate === undefined ? undefined : subagentAddressSchema.parse(candidate) as SubagentAddress;
        return {
          sessionId,
          runId,
          taskId,
          ...(rootSessionId === undefined ? {} : { rootSessionId }),
          ...(parentSessionId === undefined ? {} : { parentSessionId }),
          origin,
          ...(subagentAddress === undefined ? {} : { subagentAddress }),
          createdAt,
          updatedAt
        };
      });
  }

  prices(): PriceRate[] {
    return [...this.tables.prices.entries()].map(([, price]) => price).sort((a, b) => a.priceId.localeCompare(b.priceId));
  }

  private async attachPendingChildren(parentSessionId: string): Promise<void> {
    const pending = this.pendingChildren.get(parentSessionId);
    if (pending === undefined || pending.length === 0) return;
    this.pendingChildren.delete(parentSessionId);
    for (const child of pending) await this.attachChildSessionFromRuntime(child);
  }

  // Serialize metadata writes so both run membership and identity checks stay consistent.
  private async withAttributionWrite<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.attributionWrite;
    let release!: () => void;
    this.attributionWrite = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await fn(); }
    finally { release(); }
  }

  private sessionsForRun(runId: string): SessionRecord[] {
    return [...this.tables.sessions.entries()]
      .map(([, session]) => session)
      .filter((session) => session.runId === runId);
  }

  private usageForRun(runId: string): UsageRecord[] {
    return [...this.tables.usage.entries()]
      .map(([, record]) => record)
      .filter((record) => record.runId === runId);
  }

  private usageForSessions(sessionIds: readonly string[]): UsageRecord[] {
    const ids = new Set(sessionIds);
    return [...this.tables.usage.entries()]
      .map(([, record]) => record)
      .filter((record) => record.sessionId !== undefined && ids.has(record.sessionId));
  }

  private coreUsageRecords(): UsageRequestRecord[] {
    return [...this.tables.usage.entries()]
      .map(([, record]) => this.toCoreUsageRecord(record))
      .filter((record): record is UsageRequestRecord => record !== undefined);
  }

  private toCoreUsageRecord(record: UsageRecord): UsageRequestRecord | undefined {
    const session = record.sessionId === undefined ? undefined : this.tables.sessions.get(record.sessionId);
    const runId = record.runId ?? session?.runId;
    const sessionId = record.sessionId;
    if (runId === undefined || sessionId === undefined) return undefined;
    const provider = record.provider;
    const status = record.status === "finished" ? "completed" : record.status === "errored" ? "failed" : record.status === "aborted" ? "cancelled" : record.usage === undefined ? "usage-missing" : "completed";
    return {
      requestRecordId: record.requestRecordId,
      runId,
      sessionId,
      ...(record.taskId ?? session?.taskId ? { taskId: record.taskId ?? session?.taskId } : {}),
      ...(record.submissionId === undefined ? {} : { submissionId: record.submissionId }),
      requestOrigin: record.origin,
      provider,
      model: record.model,
      ...(record.serviceTier === undefined ? {} : { serviceTier: record.serviceTier }),
      ...(record.purpose === undefined ? {} : { purpose: record.purpose }),
      startedAt: record.startedAt,
      ...(record.finishedAt === undefined ? {} : { completedAt: record.finishedAt }),
      status,
      ...(record.usage === undefined ? {} : { usage: record.usage }),
      usageSource: record.usageSource === "historical" ? "session-history" : record.usageSource === "manual" ? "manual-import" : "llm-stream",
      ...(record.caller?.model === undefined ? {} : { callerModel: toCoreCaller(record.caller)?.model })
    };
  }

  private activeSubmissionFor(sessionId: string | undefined, startedAt: string): SubmissionRecord | undefined {
    if (sessionId === undefined) return undefined;
    const started = Date.parse(startedAt);
    const candidates = [...this.tables.submissions.entries()]
      .map(([, submission]) => submission)
      .filter((submission) => submission.sessionId === sessionId && submission.status === "active")
      .filter((submission) => Date.parse(submission.submittedAt) <= started)
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
    return candidates.length === 1 ? candidates[0] : undefined;
  }
}

export interface RuntimeSessionLike {
  id?: unknown;
  header?: { parentSession?: unknown; origin?: unknown };
  inheritedEventCount?: unknown;
  firstLiveSeq?: unknown;
}

function normalizeCaller(caller: RegisterInvocationInput["caller"]): RegisterInvocationInput["caller"] {
  return caller.model === undefined ? caller : { ...caller, model: { ...caller.model, id: normalizeCallerModelId(caller.model.id), source: caller.model.source ?? "unknown" } };
}


function inheritedSubmissionFor(session: SessionRecord | undefined, submissions: KeyValueTable<SubmissionRecord>): SubmissionRecord | undefined {
  if (session?.inheritedSubmissionId === undefined) return undefined;
  return submissions.get(session.inheritedSubmissionId);
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(value)));
}

function randomId(prefix: string): string {
  const cryptoApi = globalThis.crypto;
  const id = cryptoApi?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
}

function appendUnique(values: string[] | undefined, next: string): string[] {
  const existing = values ?? [];
  return existing.includes(next) ? existing : [...existing, next];
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function compactAggregate(aggregate: AggregateCost): Omit<AggregateCost, "requests"> {
  const { requests: _requests, ...summary } = aggregate;
  return summary;
}
