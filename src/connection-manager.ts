import type { BridgeConfig } from "./config.js";
import { DshRpcError, DshTransportError } from "./dsh-client.js";
import type { EventLedger, LedgerSnapshot } from "./event-ledger.js";
import type {
  DshApi,
  DshHostDescription,
  DshMuxFrame,
  DshPendingEnvelope,
  DshQuestionAnswer,
  DshQueuedInboxItem,
  DshServerRequest,
  DshSessionEvent,
  DshSessionHistory,
  DshSessionSummary,
  DshSubagentAddress,
} from "./dsh-types.js";
import type { TaskRecord, TaskStore } from "./task-store.js";

export const TESTED_DSH_VERSION = "0.1.0-rc.6";

export type HostAvailability = "connecting" | "connected" | "host_unreachable" | "stopped";

export interface HostConnectionSnapshot {
  availability: HostAvailability;
  baseUrl: string;
  connectionEpoch: number;
  revision: number;
  connectedAt?: string;
  disconnectedAt?: string;
  hostDescribeProductVersion?: string;
  declaredDshVersion?: string;
  testedAgainstDshVersion: typeof TESTED_DSH_VERSION;
  compatibility: "capability-probed" | "untested" | "unknown";
  warning?: string;
  lastError?: string;
  description?: DshHostDescription;
  capabilities: {
    unaryRpc: boolean;
    eventsMuxWebSocket: boolean;
    muxResumeSince: false;
    historyReconciliation: boolean;
    queueSnapshot: boolean;
    queueEmptyBaselineInference: false;
    typedRespond: boolean;
    pendingReplayReconciliation: "stable-rpcid-baseline-idle";
    subagentHistory: boolean | "not-probed";
  };
}

export interface TaskLineageSession {
  sessionId: string;
  found: boolean;
  parentSessionId?: string;
  origin: "root" | "subagent";
  running?: boolean;
  blank?: boolean;
  historyCapability: "session.history" | "subagent.history" | "unavailable";
}

export interface QueueSnapshot {
  known: boolean;
  stale: boolean;
  connectionEpoch: number;
  updatedAt?: string;
  items: DshQueuedInboxItem[];
}

export interface TaskChangeResult {
  timedOut: boolean;
  connection: HostConnectionSnapshot;
  ledger: LedgerSnapshot;
}

export interface DshConnection {
  start(): void;
  stop(): Promise<void>;
  snapshot(): HostConnectionSnapshot;
  trackTask(task: TaskRecord): Promise<void>;
  refreshLineage(): Promise<void>;
  reconcileTask(taskId: string): Promise<void>;
  readSessionHistory(
    taskId: string,
    sessionId: string,
    options?: { beforeSeq?: number; maxMessages?: number },
  ): Promise<DshSessionHistory>;
  lineageForTask(taskId: string): TaskLineageSession[];
  pendingForTask(taskId: string): DshPendingEnvelope[];
  queueForSession(sessionId: string): QueueSnapshot;
  waitForTaskChange(taskId: string, afterCursor: number, afterRevision: number, waitMs: number): Promise<TaskChangeResult>;
  answerQuestion(taskId: string, requestId: string, answers: DshQuestionAnswer[]): Promise<unknown>;
  resolveApproval(taskId: string, requestId: string, outcome: "allow_once" | "reject"): Promise<unknown>;
}

export class PendingInteractionError extends Error {
  constructor(
    readonly code:
      | "not-pending"
      | "wrong-type"
      | "wrong-task"
      | "invalid-answer"
      | "bad-response"
      | "host-unreachable",
    message: string,
  ) {
    super(message);
    this.name = "PendingInteractionError";
  }
}

interface SessionRuntime {
  lineage: TaskLineageSession;
  taskId: string;
  reconciling: boolean;
  buffer: Array<DshServerRequest<DshMuxFrame>>;
  subscribedLastSeq?: number;
  reconcilePromise: Promise<void> | undefined;
}

interface ChangeWaiter {
  taskId: string;
  afterRevision: number;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ManagerOptions {
  reconnectDelayMs?: number;
  historyPageMessages?: number;
  baselineQuietMs?: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function copyPending(envelope: DshPendingEnvelope): DshPendingEnvelope {
  return structuredClone(envelope);
}

function isPendingFrame(frame: DshMuxFrame): frame is DshPendingEnvelope["payload"] {
  return frame.type === "approval/requested" || frame.type === "question/requested";
}

function sessionIdOf(frame: DshMuxFrame): string | undefined {
  return frame.type === "stream/error" ? undefined : frame.sessionId;
}

const EPHEMERAL_CONTENT_STREAM_TYPES: ReadonlySet<string> = new Set([
  "assistant/message/delta",
  "assistant/delta",
  "assistant/chunk",
]);

function isEphemeralContentStreamType(eventType: string): boolean {
  return EPHEMERAL_CONTENT_STREAM_TYPES.has(eventType);
}

function isEphemeralContentStreamFrame(frame: DshMuxFrame): boolean {
  return frame.type === "session/event" && isEphemeralContentStreamType(frame.event.type);
}

function isTopLevelProjectionFrame(frame: DshMuxFrame): boolean {
  return frame.type === "session/projection";
}

function lineageForRoot(root: TaskRecord, summaries: DshSessionSummary[]): TaskLineageSession[] {
  const byParent = new Map<string, DshSessionSummary[]>();
  for (const summary of summaries) {
    if (summary.parentSessionId === undefined || summary.origin !== "subagent") continue;
    const children = byParent.get(summary.parentSessionId) ?? [];
    children.push(summary);
    byParent.set(summary.parentSessionId, children);
  }
  const rootSummary = summaries.find((summary) => summary.sessionId === root.sessionId);
  const result: TaskLineageSession[] = [
    {
      sessionId: root.sessionId,
      found: rootSummary !== undefined,
      origin: "root",
      ...(rootSummary === undefined ? {} : { running: rootSummary.running, blank: rootSummary.blank }),
      historyCapability: "session.history",
    },
  ];
  const queue = [root.sessionId];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const parentSessionId = queue.shift();
    if (parentSessionId === undefined) break;
    for (const child of byParent.get(parentSessionId) ?? []) {
      if (seen.has(child.sessionId)) continue;
      seen.add(child.sessionId);
      queue.push(child.sessionId);
      result.push({
        sessionId: child.sessionId,
        found: true,
        parentSessionId,
        origin: "subagent",
        running: child.running,
        blank: child.blank,
        historyCapability: "unavailable",
      });
    }
  }
  return result;
}

function lineageSignature(value: Map<string, TaskLineageSession[]>): string {
  return JSON.stringify(
    [...value.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([taskId, rows]) => [
        taskId,
        [...rows]
          .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
          .map((row) => ({
            sessionId: row.sessionId,
            found: row.found,
            parentSessionId: row.parentSessionId ?? null,
            origin: row.origin,
            running: row.running ?? null,
            blank: row.blank ?? null,
            historyCapability: row.historyCapability,
          })),
      ]),
  );
}

export class DshConnectionManager implements DshConnection {
  private state: HostConnectionSnapshot;
  private readonly pending = new Map<string, DshPendingEnvelope>();
  private readonly tombstones = new Map<string, { sessionId: string; type: string; resolvedAt: string }>();
  private readonly approvalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly queues = new Map<string, QueueSnapshot>();
  private readonly tasksById = new Map<string, TaskRecord>();
  private readonly taskBySession = new Map<string, string>();
  private readonly lineage = new Map<string, TaskLineageSession[]>();
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly subagentAddresses = new Map<string, DshSubagentAddress>();
  private readonly waiters = new Set<ChangeWaiter>();
  private readonly reconnectDelayMs: number;
  private readonly historyPageMessages: number;
  private readonly baselineQuietMs: number;
  private readonly baselineReplayed = new Set<string>();
  private readonly inferredWithdrawn = new Set<string>();
  private baselineOpen = false;
  private baselineTimer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private loopPromise: Promise<void> | undefined;
  private stopping = false;
  private readonly reconciliationPromises = new Set<Promise<void>>();

  constructor(
    private readonly config: BridgeConfig,
    private readonly api: DshApi,
    private readonly tasks: TaskStore,
    private readonly ledger: EventLedger,
    options: ManagerOptions = {},
  ) {
    this.reconnectDelayMs = options.reconnectDelayMs ?? 500;
    this.historyPageMessages = options.historyPageMessages ?? 50;
    this.baselineQuietMs = options.baselineQuietMs ?? 75;
    this.state = {
      availability: "connecting",
      baseUrl: config.hostUrl,
      connectionEpoch: 0,
      revision: 0,
      testedAgainstDshVersion: TESTED_DSH_VERSION,
      compatibility: "unknown",
      ...(config.declaredDshVersion === undefined ? {} : { declaredDshVersion: config.declaredDshVersion }),
      capabilities: {
        unaryRpc: false,
        eventsMuxWebSocket: false,
        muxResumeSince: false,
        historyReconciliation: false,
        queueSnapshot: false,
        queueEmptyBaselineInference: false,
        typedRespond: true,
        pendingReplayReconciliation: "stable-rpcid-baseline-idle",
        subagentHistory: "not-probed",
      },
    };
  }

  start(): void {
    if (this.loopPromise !== undefined) return;
    this.stopping = false;
    this.controller = new AbortController();
    this.setState({ ...this.state, availability: "connecting" });
    this.loopPromise = this.run(this.controller.signal).finally(() => {
      this.loopPromise = undefined;
      this.controller = undefined;
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const loop = this.loopPromise;
    this.controller?.abort();
    if (loop !== undefined) await loop;
    await this.waitForReconciliations();
    this.clearApprovalTimers();
    this.clearBaselineTimer();
    this.setState({ ...this.state, availability: "stopped", disconnectedAt: new Date().toISOString() });
    this.settleAllWaiters();
  }

  snapshot(): HostConnectionSnapshot {
    return structuredClone(this.state);
  }

  async trackTask(task: TaskRecord): Promise<void> {
    this.tasksById.set(task.taskId, task);
    this.lineage.set(task.taskId, [
      { sessionId: task.sessionId, found: false, origin: "root", historyCapability: "session.history" },
    ]);
    this.installRuntime(task.taskId, this.lineage.get(task.taskId)![0]!);
    if (this.state.availability === "connected") {
      await this.refreshLineage().catch(() => undefined);
      void this.reconcileSession(task.sessionId, this.controller?.signal).catch(() => undefined);
    }
  }

  async refreshLineage(): Promise<void> {
    const before = lineageSignature(this.lineage);
    const [taskRecords, list] = await Promise.all([this.tasks.list(), this.api.sessionList()]);
    this.tasksById.clear();
    this.taskBySession.clear();
    this.lineage.clear();
    this.subagentAddresses.clear();
    for (const task of taskRecords) {
      this.tasksById.set(task.taskId, task);
      const rows = lineageForRoot(task, list.items);
      this.lineage.set(task.taskId, rows);
      for (const row of rows) this.installRuntime(task.taskId, row);
    }
    const activeSessionIds = new Set([...this.lineage.values()].flatMap((rows) => rows.map((row) => row.sessionId)));
    for (const sessionId of [...this.sessions.keys()]) {
      if (activeSessionIds.has(sessionId)) continue;
      this.sessions.delete(sessionId);
      this.queues.delete(sessionId);
    }
    await this.resolveSubagentAddresses();
    if (lineageSignature(this.lineage) !== before) this.bumpRevision();
  }

  async reconcileTask(taskId: string): Promise<void> {
    const before = await this.ledger.snapshot(taskId);
    const rows = this.lineage.get(taskId) ?? [];
    await Promise.all(rows.map((row) => this.reconcileSession(row.sessionId, this.controller?.signal)));
    const after = await this.ledger.snapshot(taskId);
    if (after.cursor > before.cursor) this.bumpRevision(taskId);
  }

  async readSessionHistory(
    taskId: string,
    sessionId: string,
    options: { beforeSeq?: number; maxMessages?: number } = {},
  ): Promise<DshSessionHistory> {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined || runtime.taskId !== taskId) {
      throw new DshRpcError("session-not-found", `session ${sessionId} is not in bridge task ${taskId}`, {
        taskId,
        sessionId,
      });
    }
    return runtime.lineage.origin === "root"
      ? this.api.sessionHistory(sessionId, options)
      : this.readSubagentHistory(runtime, options);
  }

  lineageForTask(taskId: string): TaskLineageSession[] {
    return (this.lineage.get(taskId) ?? []).map((row) => ({ ...row }));
  }

  pendingForTask(taskId: string): DshPendingEnvelope[] {
    return [...this.pending.values()]
      .filter((envelope) => this.taskBySession.get(envelope.payload.sessionId) === taskId)
      .map(copyPending);
  }

  queueForSession(sessionId: string): QueueSnapshot {
    const queue = this.queues.get(sessionId);
    if (queue !== undefined) return structuredClone(queue);
    return {
      known: false,
      stale: this.state.availability !== "connected",
      connectionEpoch: this.state.connectionEpoch,
      items: [],
    };
  }

  async waitForTaskChange(
    taskId: string,
    afterCursor: number,
    afterRevision: number,
    waitMs: number,
  ): Promise<TaskChangeResult> {
    const before = await this.ledger.snapshot(taskId);
    if (before.cursor > afterCursor || this.state.revision > afterRevision || waitMs <= 0) {
      return { timedOut: false, connection: this.snapshot(), ledger: before };
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      let waiter: ChangeWaiter;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        resolve();
      };
      waiter = {
        taskId,
        afterRevision,
        resolve: settle,
        timer: setTimeout(settle, waitMs),
      };
      this.waiters.add(waiter);
      void this.ledger.waitForCursor(taskId, afterCursor, waitMs).then(settle, settle);
    });
    const ledger = await this.ledger.snapshot(taskId);
    const timedOut = ledger.cursor <= afterCursor && this.state.revision <= afterRevision;
    return { timedOut, connection: this.snapshot(), ledger };
  }

  async answerQuestion(taskId: string, requestId: string, answers: DshQuestionAnswer[]) {
    this.requireConnected();
    const envelope = this.requirePending(requestId, taskId, "question/requested");
    this.validateAnswers(envelope, answers);
    const sessionId = envelope.payload.sessionId;
    const receipt = await this.api.respond({
      type: "client-response",
      rpcId: requestId,
      result: { ok: true, value: { sessionId, answer: { answers } } },
    });
    await this.handleReceipt(taskId, requestId, envelope, receipt);
    return { requestId, sessionId, accepted: true, interaction: "question" };
  }

  async resolveApproval(taskId: string, requestId: string, outcome: "allow_once" | "reject") {
    this.requireConnected();
    const envelope = this.requirePending(requestId, taskId, "approval/requested");
    const sessionId = envelope.payload.sessionId;
    const receipt = await this.api.respond({
      type: "client-response",
      rpcId: requestId,
      result: {
        ok: true,
        value: {
          sessionId,
          approvalId: envelope.payload.approvalId,
          outcome: outcome === "allow_once" ? "allowed-once" : "rejected",
        },
      },
    });
    await this.handleReceipt(taskId, requestId, envelope, receipt);
    return { requestId, sessionId, accepted: true, interaction: "approval", outcome };
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const description = await this.api.hostDescribe(signal);
        await this.refreshLineage();
        let opened = false;
        const stream = this.api.openMux(signal, () => {
          opened = true;
          this.onConnected(description, signal);
        });
        for await (const envelope of stream) {
          if (!opened) {
            opened = true;
            this.onConnected(description, signal);
          }
          await this.onEnvelope(envelope, signal);
        }
        if (!signal.aborted) throw new DshTransportError("DSH events.mux stream closed");
      } catch (error) {
        if (signal.aborted) break;
        await this.onDisconnected(error);
        await sleep(this.reconnectDelayMs, signal);
        if (!signal.aborted) this.setState({ ...this.state, availability: "connecting" });
      }
    }
  }

  private onConnected(description: DshHostDescription, signal: AbortSignal): void {
    this.pending.clear();
    this.clearApprovalTimers();
    this.clearBaselineTimer();
    this.baselineOpen = true;
    this.baselineReplayed.clear();
    const epoch = this.state.connectionEpoch + 1;
    for (const runtime of this.sessions.values()) {
      runtime.reconciling = true;
      runtime.buffer = [];
      delete runtime.subscribedLastSeq;
      this.queues.set(runtime.lineage.sessionId, {
        // A mux connection opening is not itself evidence that the Host queue is
        // empty.  rc.6 sends session/queue only when it has a snapshot to
        // publish, so keep the view unknown until that frame actually arrives.
        // This prevents a queue cancellation racing the baseline from silently
        // succeeding without removing anything.
        known: false,
        stale: false,
        connectionEpoch: epoch,
        items: [],
      });
    }
    const declaredVersion = this.config.declaredDshVersion;
    const compatibility = declaredVersion === TESTED_DSH_VERSION ? "capability-probed" : "untested";
    const warnings = [
      declaredVersion === undefined
        ? `DSH CLI/package version is unknown to the bridge runtime; only ${TESTED_DSH_VERSION} was locally verified`
        : declaredVersion === TESTED_DSH_VERSION
          ? undefined
          : `Operator-declared DSH version ${declaredVersion} is untested; only ${TESTED_DSH_VERSION} was locally verified`,
      description.version === "0.0.1"
        ? "host.describe.version is the rc.6 placeholder, not the DSH CLI/package version"
        : `Host product version ${description.version} is reported separately from the DSH CLI/package version`,
    ].filter((warning): warning is string => warning !== undefined);
    this.setState({
      availability: "connected",
      baseUrl: this.config.hostUrl,
      connectionEpoch: epoch,
      revision: this.state.revision,
      connectedAt: new Date().toISOString(),
      hostDescribeProductVersion: description.version,
      testedAgainstDshVersion: TESTED_DSH_VERSION,
      compatibility,
      warning: warnings.join("; "),
      ...(this.config.declaredDshVersion === undefined ? {} : { declaredDshVersion: this.config.declaredDshVersion }),
      description,
      capabilities: {
        ...this.state.capabilities,
        unaryRpc: true,
        eventsMuxWebSocket: true,
        queueSnapshot: true,
      },
    });
    const fallback = setTimeout(() => {
      if (signal.aborted) return;
      void this.reconcileAll(signal).catch((error) => {
        if (!signal.aborted) this.setState({ ...this.state, lastError: `history reconciliation: ${errorText(error)}` });
      });
    }, 25);
    fallback.unref?.();
    this.touchBaseline(signal, epoch);
  }

  private async onDisconnected(error: unknown): Promise<void> {
    this.clearApprovalTimers();
    this.clearBaselineTimer();
    this.baselineOpen = false;
    for (const [sessionId, snapshot] of this.queues) {
      this.queues.set(sessionId, { ...snapshot, known: false, stale: true });
    }
    this.setState({
      ...this.state,
      availability: "host_unreachable",
      disconnectedAt: new Date().toISOString(),
      lastError: errorText(error),
    });
    if (error instanceof DshRpcError) {
      await Promise.all(
        [...this.tasksById.values()].map((task) =>
          this.ledger
            .append(task.taskId, {
              sourceSessionId: task.sessionId,
              origin: "root",
              type: "stream/error",
              raw: { error: { code: error.code } },
            })
            .catch(() => undefined),
        ),
      );
    }
  }

  private async onEnvelope(envelope: DshServerRequest<DshMuxFrame>, signal: AbortSignal): Promise<void> {
    const frame = envelope.payload;
    if (this.baselineOpen) {
      if (isPendingFrame(frame)) this.baselineReplayed.add(envelope.rpcId);
      this.touchBaseline(signal, this.state.connectionEpoch);
    }
    if (isPendingFrame(frame)) {
      if (!this.tombstones.has(envelope.rpcId)) {
        this.pending.set(envelope.rpcId, copyPending(envelope as DshPendingEnvelope));
        if (frame.type === "approval/requested") this.scheduleApprovalTimeout(envelope as DshPendingEnvelope);
      }
    } else if (frame.type === "approval/resolved") {
      for (const [requestId, pending] of this.pending) {
        if (
          pending.payload.type === "approval/requested" &&
          pending.payload.sessionId === frame.sessionId &&
          pending.payload.approvalId === frame.approvalId
        ) {
          this.tombstone(requestId, pending.payload.sessionId, frame.type);
        }
      }
    } else if (frame.type === "question/resolved") {
      this.tombstone(frame.questionRpcId, frame.sessionId, frame.type);
    } else if (frame.type === "session/queue") {
      this.queues.set(frame.sessionId, {
        known: true,
        stale: false,
        connectionEpoch: this.state.connectionEpoch,
        updatedAt: new Date().toISOString(),
        items: structuredClone(frame.items),
      });
    }

    const sessionId = sessionIdOf(frame);
    if (sessionId === undefined) return;
    let runtime = this.sessions.get(sessionId);
    if (runtime === undefined) {
      await this.refreshLineage();
      runtime = this.sessions.get(sessionId);
      if (runtime === undefined) return;
    }

    if (frame.type === "session/subscribed") {
      runtime.subscribedLastSeq = frame.lastSeq;
      void this.reconcileSession(sessionId, signal).catch(() => undefined);
      return;
    }

    if (runtime.reconciling) {
      runtime.buffer.push(envelope);
      return;
    }

    // Only bump the connection revision for durable ledger records.
    const persisted = await this.appendEnvelope(runtime, envelope);
    if (persisted) this.bumpRevision(runtime.taskId);
  }

  // Top-level projections and ephemeral assistant stream chunks are not ledger
  // records. Other top-level frames, including session/jobs, remain durable.
  private async appendEnvelope(runtime: SessionRuntime, envelope: DshServerRequest<DshMuxFrame>): Promise<boolean> {
    const frame = envelope.payload;
    if (isEphemeralContentStreamFrame(frame) || isTopLevelProjectionFrame(frame)) return false;
    if (isPendingFrame(frame) && this.inferredWithdrawn.delete(envelope.rpcId)) {
      await this.ledger.append(runtime.taskId, {
        sourceSessionId: runtime.lineage.sessionId,
        ...(runtime.lineage.parentSessionId === undefined ? {} : { parentSessionId: runtime.lineage.parentSessionId }),
        origin: runtime.lineage.origin,
        type: "interaction/replayed",
        raw: {
          requestId: envelope.rpcId,
          interaction: frame.type,
          ...(frame.type === "approval/requested" ? { approvalId: frame.approvalId } : {}),
        },
      });
      return true;
    }
    await this.ledger.append(runtime.taskId, {
      sourceSessionId: runtime.lineage.sessionId,
      ...(frame.type === "session/event" ? { sourceSeq: frame.event.seq } : {}),
      ...(runtime.lineage.parentSessionId === undefined ? {} : { parentSessionId: runtime.lineage.parentSessionId }),
      origin: runtime.lineage.origin,
      type: frame.type,
      raw: envelope,
    });
    return true;
  }

  private async reconcileAll(signal?: AbortSignal): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.reconcileSession(sessionId, signal)));
    if (this.state.availability === "connected") {
      this.setState({
        ...this.state,
        capabilities: { ...this.state.capabilities, historyReconciliation: true },
      });
    }
  }

  private async reconcileSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    if (this.stopping || signal?.aborted === true) return;
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;
    if (runtime.reconcilePromise !== undefined) return runtime.reconcilePromise;
    runtime.reconciling = true;
    const operation = (async () => {
      const snapshot = await this.ledger.snapshot(runtime.taskId);
      const highWatermark = snapshot.watermarks[sessionId] ?? -1;
      if (runtime.subscribedLastSeq !== undefined && runtime.subscribedLastSeq <= highWatermark) {
        await this.drainBuffer(runtime);
        return;
      }
      let recovered;
      try {
        recovered = await this.readMissingHistory(runtime, highWatermark, signal);
      } catch (error) {
        if (error instanceof DshTransportError || signal?.aborted === true) throw error;
        if (runtime.lineage.origin === "root" && error instanceof DshRpcError && error.code === "session-not-found") {
          await this.drainBuffer(runtime);
          return;
        }
        await this.ledger.markGap(runtime.taskId, {
          sourceSessionId: sessionId,
          expectedSeq: highWatermark + 1,
          reason: "history reconciliation capability unavailable",
          error: errorText(error),
        });
        await this.drainBuffer(runtime);
        return;
      }
      recovered.sort((a, b) => a.event.seq - b.event.seq);
      if (recovered.length > 0) {
        const first = recovered[0]!.event.seq;
        if (first > highWatermark + 1) {
          await this.ledger.markGap(runtime.taskId, {
            sourceSessionId: sessionId,
            expectedSeq: highWatermark + 1,
            firstRecoveredSeq: first,
            reason: "history no longer contains the required contiguous range",
          });
          await this.drainBuffer(runtime);
          return;
        }
        for (const entry of recovered) {
          if (isEphemeralContentStreamType(entry.event.type)) continue;
          await this.ledger.append(runtime.taskId, {
            sourceSessionId: sessionId,
            sourceSeq: entry.event.seq,
            ...(runtime.lineage.parentSessionId === undefined ? {} : { parentSessionId: runtime.lineage.parentSessionId }),
            origin: runtime.lineage.origin,
            type: "session/event",
            raw: { type: "session/event", sessionId, event: entry.event, ...(entry.view === undefined ? {} : { view: entry.view }) },
          });
        }
      }
      await this.drainBuffer(runtime);
    })();
    const work = operation.finally(() => {
      runtime.reconciling = false;
      runtime.reconcilePromise = undefined;
    });
    runtime.reconcilePromise = work;
    this.reconciliationPromises.add(work);
    void work.then(
      () => this.reconciliationPromises.delete(work),
      () => this.reconciliationPromises.delete(work),
    );
    return work;
  }

  private async waitForReconciliations(): Promise<void> {
    // No new reconciliation may start once stopping is set. Looping still
    // closes the small observation window where a settling promise clears
    // itself in finally while stop is collecting the current runtimes.
    while (true) {
      const pending = [...this.reconciliationPromises];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  private async readMissingHistory(runtime: SessionRuntime, highWatermark: number, signal?: AbortSignal) {
    const recovered: Array<{ event: DshSessionEvent; view?: unknown }> = [];
    let beforeSeq: number | undefined;
    let complete = false;
    for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
      const options = {
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        maxMessages: this.historyPageMessages,
      };
      const history =
        runtime.lineage.origin === "root"
          ? await this.api.sessionHistory(runtime.lineage.sessionId, options, signal)
          : await this.readSubagentHistory(runtime, options, signal);
      for (const entry of history.events) {
        if (entry.event.seq > highWatermark) recovered.push(entry);
      }
      const firstSeq = history.events[0]?.event.seq;
      if (!history.hasMore || firstSeq === undefined || firstSeq <= highWatermark + 1) {
        complete = true;
        break;
      }
      beforeSeq = firstSeq;
    }
    if (!complete) throw new Error("history reconciliation exceeded 10000 pages");
    return recovered;
  }

  private async readSubagentHistory(
    runtime: SessionRuntime,
    options: { beforeSeq?: number; maxMessages?: number },
    signal?: AbortSignal,
  ) {
    const address = this.subagentAddresses.get(runtime.lineage.sessionId);
    if (address === undefined) {
      runtime.lineage.historyCapability = "unavailable";
      throw new Error(`subagent history capability unavailable for ${runtime.lineage.sessionId}`);
    }
    runtime.lineage.historyCapability = "subagent.history";
    return this.api.subagentHistory(address, options, signal);
  }

  private async drainBuffer(runtime: SessionRuntime): Promise<void> {
    while (runtime.buffer.length > 0) {
      const batch = runtime.buffer.splice(0).sort((left, right) => {
        const leftSeq = left.payload.type === "session/event" ? left.payload.event.seq : Number.MAX_SAFE_INTEGER;
        const rightSeq = right.payload.type === "session/event" ? right.payload.event.seq : Number.MAX_SAFE_INTEGER;
        return leftSeq - rightSeq;
      });
      for (const envelope of batch) {
        const persisted = await this.appendEnvelope(runtime, envelope);
        if (persisted) this.bumpRevision(runtime.taskId);
      }
    }
  }

  private installRuntime(taskId: string, row: TaskLineageSession): void {
    this.taskBySession.set(row.sessionId, taskId);
    const existing = this.sessions.get(row.sessionId);
    if (existing === undefined) {
      this.sessions.set(row.sessionId, {
        lineage: row,
        taskId,
        reconciling: true,
        buffer: [],
        reconcilePromise: undefined,
      });
    } else {
      existing.lineage = row;
      existing.taskId = taskId;
    }
  }

  private async resolveSubagentAddresses(): Promise<void> {
    const parents = new Set<string>();
    for (const rows of this.lineage.values()) {
      for (const row of rows) if (row.parentSessionId !== undefined) parents.add(row.parentSessionId);
    }
    let probed = false;
    for (const parentSessionId of parents) {
      try {
        const catalog = await this.api.subagentList(parentSessionId);
        probed = true;
        for (const entry of catalog.entries) {
          if (entry.kind !== "child") continue;
          this.subagentAddresses.set(entry.id, { parentSessionId, childSessionId: entry.id, mode: entry.mode });
          const runtime = this.sessions.get(entry.id);
          if (runtime !== undefined) runtime.lineage.historyCapability = "subagent.history";
        }
      } catch {
        // The affected lineage rows retain an explicit unavailable capability.
      }
    }
    if (probed) {
      this.state = { ...this.state, capabilities: { ...this.state.capabilities, subagentHistory: true } };
    }
  }

  private requireConnected(): void {
    if (this.state.availability !== "connected") {
      throw new PendingInteractionError("host-unreachable", "DSH Host is not currently connected");
    }
  }

  private requirePending<T extends "approval/requested" | "question/requested">(
    requestId: string,
    taskId: string,
    type: T,
  ): Extract<DshPendingEnvelope, { payload: { type: T } }> {
    const pending = this.pending.get(requestId);
    if (pending === undefined) throw new PendingInteractionError("not-pending", `request ${JSON.stringify(requestId)} is not pending`);
    if (pending.payload.type !== type) {
      throw new PendingInteractionError("wrong-type", `request ${JSON.stringify(requestId)} is ${pending.payload.type}, not ${type}`);
    }
    if (this.taskBySession.get(pending.payload.sessionId) !== taskId) {
      throw new PendingInteractionError("wrong-task", `request ${JSON.stringify(requestId)} belongs to another bridge task`);
    }
    return pending as Extract<DshPendingEnvelope, { payload: { type: T } }>;
  }

  private validateAnswers(
    envelope: Extract<DshPendingEnvelope, { payload: { type: "question/requested" } }>,
    answers: DshQuestionAnswer[],
  ): void {
    const questions = envelope.payload.questions;
    if (answers.length !== questions.length) {
      throw new PendingInteractionError("invalid-answer", "answers must contain exactly one item for each pending question");
    }
    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index];
      const answer = answers[index];
      if (question === undefined || answer === undefined || answer.id !== question.id) {
        throw new PendingInteractionError("invalid-answer", "answers must preserve the pending question order and ids");
      }
      if (new Set(answer.selected).size !== answer.selected.length) {
        throw new PendingInteractionError("invalid-answer", `question ${JSON.stringify(answer.id)} contains duplicate selections`);
      }
      const custom = answer.custom?.trim();
      if (custom !== undefined && custom === "") {
        throw new PendingInteractionError("invalid-answer", `question ${JSON.stringify(answer.id)} has a blank custom answer`);
      }
      if (question.multiSelect !== true && answer.selected.length > 1) {
        throw new PendingInteractionError("invalid-answer", `question ${JSON.stringify(answer.id)} accepts at most one selection`);
      }
      if (question.multiSelect !== true && custom !== undefined && answer.selected.length > 0) {
        throw new PendingInteractionError("invalid-answer", `question ${JSON.stringify(answer.id)} cannot mix a selection with custom text`);
      }
      const labels = new Set(question.options?.map((option) => option.label) ?? []);
      if (!answer.selected.every((label) => labels.has(label))) {
        throw new PendingInteractionError("invalid-answer", `question ${JSON.stringify(answer.id)} contains an unknown selection`);
      }
    }
  }

  private async handleReceipt(
    taskId: string,
    requestId: string,
    envelope: DshPendingEnvelope,
    receipt: { accepted: true } | { accepted: false; reason: "not-pending" | "bad-response" },
  ): Promise<void> {
    const runtime = this.sessions.get(envelope.payload.sessionId);
    const raw = {
      requestId,
      interaction: envelope.payload.type === "approval/requested" ? "approval" : "question",
      ...(envelope.payload.type === "approval/requested" ? { approvalId: envelope.payload.approvalId } : {}),
    };
    if (receipt.accepted) {
      this.tombstone(requestId, envelope.payload.sessionId, "respond/accepted");
      await this.ledger.append(taskId, {
        sourceSessionId: envelope.payload.sessionId,
        ...(runtime?.lineage.parentSessionId === undefined ? {} : { parentSessionId: runtime.lineage.parentSessionId }),
        origin: runtime?.lineage.origin ?? "root",
        type: "respond/accepted",
        raw,
      });
      return;
    }
    if (receipt.reason === "not-pending") {
      this.tombstone(requestId, envelope.payload.sessionId, "respond/not-pending");
      await this.ledger.append(taskId, {
        sourceSessionId: envelope.payload.sessionId,
        ...(runtime?.lineage.parentSessionId === undefined ? {} : { parentSessionId: runtime.lineage.parentSessionId }),
        origin: runtime?.lineage.origin ?? "root",
        type: "respond/not-pending",
        raw,
      });
      throw new PendingInteractionError("not-pending", "DSH reports that this request is no longer pending");
    }
    throw new PendingInteractionError("bad-response", "DSH rejected the typed response as invalid; the request remains pending");
  }

  private scheduleApprovalTimeout(envelope: DshPendingEnvelope): void {
    const timeoutMs = this.config.approvalTimeoutMs;
    if (timeoutMs === undefined || envelope.payload.type !== "approval/requested") return;
    if (this.approvalTimers.has(envelope.rpcId)) return;
    const timer = setTimeout(() => {
      this.approvalTimers.delete(envelope.rpcId);
      const pending = this.pending.get(envelope.rpcId);
      if (pending?.payload.type !== "approval/requested" || this.state.availability !== "connected") return;
      void this.api
        .respond({
          type: "client-response",
          rpcId: pending.rpcId,
          result: {
            ok: true,
            value: {
              sessionId: pending.payload.sessionId,
              approvalId: pending.payload.approvalId,
              outcome: "rejected",
            },
          },
        })
        .then(async (receipt) => {
          if (!receipt.accepted) return;
          const taskId = this.taskBySession.get(pending.payload.sessionId);
          const runtime = this.sessions.get(pending.payload.sessionId);
          this.tombstone(pending.rpcId, pending.payload.sessionId, "timeout/rejected");
          if (taskId !== undefined) {
            await this.ledger.append(taskId, {
              sourceSessionId: pending.payload.sessionId,
              ...(runtime?.lineage.parentSessionId === undefined
                ? {}
                : { parentSessionId: runtime.lineage.parentSessionId }),
              origin: runtime?.lineage.origin ?? "root",
              type: "respond/accepted",
              raw: {
                requestId: pending.rpcId,
                interaction: "approval",
                approvalId: pending.payload.approvalId,
                outcome: "rejected",
                source: "bridge-best-effort-timeout",
              },
            });
          }
        })
        .catch(() => undefined);
    }, timeoutMs);
    this.approvalTimers.set(envelope.rpcId, timer);
  }

  private tombstone(requestId: string, sessionId: string, type: string): void {
    this.pending.delete(requestId);
    const timer = this.approvalTimers.get(requestId);
    if (timer !== undefined) clearTimeout(timer);
    this.approvalTimers.delete(requestId);
    this.tombstones.set(requestId, { sessionId, type, resolvedAt: new Date().toISOString() });
    if (this.tombstones.size > 4_096) this.tombstones.delete(this.tombstones.keys().next().value as string);
    this.bumpRevision(this.taskBySession.get(sessionId));
  }

  private clearApprovalTimers(): void {
    for (const timer of this.approvalTimers.values()) clearTimeout(timer);
    this.approvalTimers.clear();
  }

  private touchBaseline(signal: AbortSignal, epoch: number): void {
    this.clearBaselineTimer();
    const timer = setTimeout(() => {
      this.baselineTimer = undefined;
      if (signal.aborted || !this.baselineOpen || this.state.connectionEpoch !== epoch) return;
      this.baselineOpen = false;
      void this.finalizePendingBaseline(epoch).catch((error) => {
        if (!signal.aborted) this.setState({ ...this.state, lastError: `pending baseline reconciliation: ${errorText(error)}` });
      });
    }, this.baselineQuietMs);
    timer.unref?.();
    this.baselineTimer = timer;
  }

  private clearBaselineTimer(): void {
    if (this.baselineTimer !== undefined) clearTimeout(this.baselineTimer);
    this.baselineTimer = undefined;
  }

  private async finalizePendingBaseline(epoch: number): Promise<void> {
    for (const task of this.tasksById.values()) {
      const snapshot = await this.ledger.snapshot(task.taskId);
      let changed = false;
      for (const pending of snapshot.pendingInteractions) {
        const requestId = pending.requestId;
        if (requestId === undefined || this.baselineReplayed.has(requestId)) continue;
        this.inferredWithdrawn.add(requestId);
        const runtime = this.sessions.get(pending.sessionId);
        const appended = await this.ledger.append(task.taskId, {
          sourceSessionId: pending.sessionId,
          ...(runtime?.lineage.parentSessionId === undefined ? {} : { parentSessionId: runtime.lineage.parentSessionId }),
          origin: runtime?.lineage.origin ?? "root",
          type: "interaction/withdrawn",
          raw: {
            requestId,
            ...(pending.approvalId === undefined ? {} : { approvalId: pending.approvalId }),
            interaction: pending.type,
            reason: "absent-from-current-mux-pending-baseline",
            connectionEpoch: epoch,
          },
        });
        changed ||= appended !== undefined;
      }
      if (changed) this.bumpRevision(task.taskId);
    }
  }

  private setState(next: HostConnectionSnapshot): void {
    this.state = { ...next, revision: this.state.revision + 1 };
    this.notifyChange();
  }

  private bumpRevision(taskId?: string): void {
    this.state = { ...this.state, revision: this.state.revision + 1 };
    this.notifyChange(taskId);
  }

  private notifyChange(taskId?: string): void {
    for (const waiter of [...this.waiters]) {
      if (taskId !== undefined && waiter.taskId !== taskId) continue;
      if (this.state.revision <= waiter.afterRevision && taskId === undefined) continue;
      waiter.resolve();
    }
  }

  private settleAllWaiters(): void {
    for (const waiter of [...this.waiters]) waiter.resolve();
  }
}
