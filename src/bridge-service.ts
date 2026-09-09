import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { BridgeAttributionStore, type CallerInfo, type CallerModelSource, type InvocationRecord } from "./bridge-attribution.js";
import type { BridgeConfig } from "./config.js";
import type { DshConnection, HostConnectionSnapshot, QueueSnapshot, TaskLineageSession } from "./connection-manager.js";
import { DshRpcError, DshTransportError, formatModel } from "./dsh-client.js";
import type {
  EventLedger,
  LedgerEventPointer,
  LedgerExecution,
  LedgerSnapshot,
  TailDigestRecord,
} from "./event-ledger.js";
import { getDshUnaryMetadata } from "./dsh-types.js";
import type { DshApi, DshHistoryEntry, DshQuestionAnswer } from "./dsh-types.js";
import type { TailKind } from "./response-view.js";
import type { TaskRecord } from "./task-store.js";
import { TaskStore } from "./task-store.js";
import type { WorkspaceClaimMode } from "./workspace-claim.js";
import { WorkspaceClaimConflictError, WorkspaceClaimStore } from "./workspace-claim.js";

export interface DelegateInput {
  prompt: string;
  cwd: string;
  runId?: string | undefined;
  caller?: CallerInput | undefined;
  agentPreset?: string;
  title?: string;
  waitSeconds?: number;
  workspaceMode?: WorkspaceClaimMode;
}

export interface CallerModelInput {
  provider: string;
  id: string;
  serviceTier?: string | undefined;
  source?: CallerModelSource | undefined;
}

export interface CallerInput {
  client?: string | undefined;
  conversationId?: string | undefined;
  model?: CallerModelInput | undefined;
}

export interface WritePreconditions {
  sinceCursor?: number;
  expectedRevision?: number;
}

export type WaitWakeOn = "attention" | "activity";

export type TaskAvailability = "connected" | "host_unreachable" | "session_not_found";

export class DelegationSetupError extends Error {
  constructor(
    readonly stage: "mapping" | "workspace-claim" | "models" | "prompt",
    message: string,
    readonly sessionId: string,
    readonly taskId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DelegationSetupError";
  }
}

export class BridgeCapabilityError extends Error {
  constructor(
    readonly code:
      | "queue_snapshot_unavailable"
      | "session_not_found"
      | "host_unreachable"
      | "model_unroutable"
      | "workspace_claim_missing"
      | "unsupported",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BridgeCapabilityError";
  }
}

export class StaleViewError extends Error {
  readonly code = "stale_view";

  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "StaleViewError";
  }
}

function promptPayload(config: BridgeConfig, sessionId: string, prompt: string, mode: "queue" | "steer") {
  return {
    sessionId,
    mode,
    content: [{ type: "text" as const, text: prompt }],
    ...(config.clientTimeZone === undefined ? {} : { clientTimeZone: config.clientTimeZone }),
  };
}

function deriveTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? "DSH task";
  const compact = firstLine.replace(/\s+/g, " ").slice(0, 72);
  return `Codex · ${compact === "" ? "DSH task" : compact}`;
}

function hostStartCommand(hostUrl: string): string {
  const url = new URL(hostUrl);
  const host = url.hostname === "[::1]" ? "::1" : url.hostname;
  const port = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
  return `dsh web --host ${host} --port ${port}`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeCaller(caller?: CallerInput): CallerInfo {
  const client = caller?.client?.trim() || "codex";
  return {
    client,
    ...(caller?.conversationId === undefined ? {} : { conversationId: caller.conversationId }),
    model:
      caller?.model === undefined
        ? { provider: "unknown", id: "unknown", source: "unknown" }
        : {
            provider: caller.model.provider,
            id: caller.model.id,
            serviceTier: caller.model.serviceTier ?? "standard",
            source: caller.model.source ?? "caller-reported",
          },
  };
}

function callerFromCompanion(value: unknown): CallerInfo | undefined {
  const caller = asObject(value);
  if (caller === undefined || typeof caller.client !== "string" || caller.client.trim() === "") return undefined;
  const model = asObject(caller.model);
  let source: CallerModelSource = "unknown";
  if (
    model?.source === "caller-reported" ||
    model?.source === "adapter" ||
    model?.source === "user-config" ||
    model?.source === "unknown"
  ) {
    source = model.source;
  } else if (model?.source === "configured") {
    source = "user-config";
  }
  return {
    client: caller.client.trim(),
    ...(typeof caller.conversationId === "string" ? { conversationId: caller.conversationId } : {}),
    ...(typeof model?.provider === "string" && typeof model.id === "string"
      ? {
          model: {
            provider: model.provider,
            id: model.id,
            ...(typeof model.serviceTier === "string" ? { serviceTier: model.serviceTier } : {}),
            source,
          },
        }
      : { model: { provider: "unknown", id: "unknown", source: "unknown" } }),
  };
}

function warningJoin(...warnings: Array<string | undefined>): string | undefined {
  const present = warnings.filter((warning): warning is string => warning !== undefined && warning.length > 0);
  return present.length === 0 ? undefined : present.join("; ");
}

function contentText(value: unknown): string | undefined {
  const content = asObject(value)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((block) => {
      const item = asObject(block);
      return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .join("");
  return text === "" ? undefined : text;
}

function historyDigest(entry: DshHistoryEntry): unknown {
  const event = entry.event;
  const data = asObject(event.data);
  if (event.type === "user/message") {
    return { eventType: event.type, seq: event.seq, time: event.time, text: contentText(event.data) };
  }
  if (event.type === "assistant/message") {
    return {
      eventType: event.type,
      seq: event.seq,
      time: event.time,
      text: contentText(data?.message),
    };
  }
  if (event.type === "assistant/message/delta" || event.type === "assistant/delta" || event.type === "assistant/chunk") {
    return { eventType: event.type, seq: event.seq, time: event.time, omitted: "assistant_chunk" };
  }
  if (event.type === "tool/result") {
    const meta = asObject(data?.meta);
    return {
      eventType: event.type,
      seq: event.seq,
      time: event.time,
      error: data?.error,
      paths: data?.paths ?? meta?.paths,
      stats: data?.stats ?? meta?.stats,
      result: typeof data?.result === "string" ? data.result.slice(0, 2_000) : undefined,
      truncated: typeof data?.result === "string" && data.result.length > 2_000,
    };
  }
  if (event.type === "tool/call") {
    return { eventType: event.type, seq: event.seq, time: event.time, tool: data?.name };
  }
  if (event.type === "turn/start" || event.type === "turn/end") {
    return { eventType: event.type, seq: event.seq, time: event.time, data: event.data };
  }
  return { eventType: event.type, seq: event.seq, time: event.time };
}

function interactionExecution(pending: ReturnType<DshConnection["pendingForTask"]>): LedgerExecution | undefined {
  if (pending.some((envelope) => envelope.payload.type === "approval/requested")) return "awaiting_approval";
  if (pending.some((envelope) => envelope.payload.type === "question/requested")) return "awaiting_input";
  return undefined;
}

function isTerminal(execution: LedgerExecution): boolean {
  return execution === "turn_completed" || execution === "failed" || execution === "canceled" || execution === "interrupted";
}

function waitAttentionReason(status: Record<string, any>, cursor: number, explicitCursor: boolean): string | undefined {
  if (status.availability !== "connected") return status.availability;
  if (status.recovery?.state === "unrecoverable_gap") return "unrecoverable_gap";
  if (Array.isArray(status.pendingInteractions) && status.pendingInteractions.length > 0) return "pending_interaction";
  if (isTerminal(status.execution) && (status.cursor > cursor || !explicitCursor)) return status.execution;
  return undefined;
}

function tailEventType(record: TailDigestRecord): string {
  const digest = record.digest;
  if (typeof digest === "object" && digest !== null) {
    const digestObject = digest as Record<string, unknown>;
    const type = digestObject.type;
    if (typeof type === "string") return type;
    const eventType = digestObject.eventType;
    if (typeof eventType === "string") return eventType;
    const coordination = digestObject.coordination;
    if (typeof coordination === "object" && coordination !== null) {
      const eventType = (coordination as Record<string, unknown>).eventType;
      if (typeof eventType === "string") return eventType;
      const nested = (coordination as Record<string, unknown>).coordination;
      if (typeof nested === "object" && nested !== null) {
        const nestedEventType = (nested as Record<string, unknown>).eventType;
        if (typeof nestedEventType === "string") return nestedEventType;
      }
    }
  }
  return record.type;
}

function tailMatches(record: TailDigestRecord, kinds: TailKind[]): boolean {
  const kindSet = new Set(kinds);
  if (kindSet.has("all")) return true;
  const type = tailEventType(record);
  if (kindSet.has("message") && type.endsWith("/message")) return true;
  if (kindSet.has("final") && type === "assistant/message") return true;
  if (kindSet.has("turn") && type.startsWith("turn/")) return true;
  if (
    kindSet.has("interaction") &&
    (type.startsWith("question/") || type.startsWith("approval/") || type.startsWith("interaction/"))
  ) {
    return true;
  }
  if (kindSet.has("bridge") && type.startsWith("bridge/")) return true;
  if (kindSet.has("queue") && type === "session/queue") return true;
  if (kindSet.has("jobs") && type === "session/jobs") return true;
  if (kindSet.has("error") && (type.endsWith("/error") || type === "stream/error")) return true;
  if (kindSet.has("attention")) {
    if (type === "assistant/message" || type === "turn/end" || type === "stream/error") return true;
    if (type.startsWith("question/") || type.startsWith("approval/") || type.startsWith("interaction/")) return true;
    return type === "bridge/turn-interrupted";
  }
  return false;
}

function queueDepth(snapshot: QueueSnapshot) {
  const nextTurn = snapshot.items.filter((item) => item.placement === "queued").length;
  const steering = snapshot.items.filter((item) => item.placement === "steering").length;
  const context = snapshot.items.filter((item) => item.placement === "context").length;
  return {
    known: snapshot.known && !snapshot.stale,
    stale: snapshot.stale,
    nextTurn,
    nextStep: steering + context,
    steering,
    context,
    total: snapshot.items.length,
  };
}

function statusShape(
  task: TaskRecord,
  connection: HostConnectionSnapshot,
  ledger: LedgerSnapshot,
  lineage: TaskLineageSession[],
  availability: TaskAvailability,
  execution: LedgerExecution,
  pending: ReturnType<DshConnection["pendingForTask"]>,
  queue: QueueSnapshot,
  workspaceClaim: Awaited<ReturnType<WorkspaceClaimStore["get"]>>,
  attribution?: InvocationRecord | undefined,
) {
  return {
    taskId: task.taskId,
    rootSessionId: task.sessionId,
    ...(attribution?.runId === undefined ? {} : { runId: attribution.runId }),
    availability,
    execution,
    status: availability === "connected" ? execution : "unknown",
    lastKnownExecutionStatus: availability === "connected" ? execution : ledger.lastKnownExecutionStatus,
    turn: ledger.currentTurn ?? null,
    pendingInteractions: pending,
    queueDepth: queueDepth(queue),
    finalMessage: null,
    finalMessagePointer: ledger.finalMessagePointer ?? null,
    finalMessageStatus:
      isTerminal(execution) &&
      (ledger.terminalMissingFinal || (execution === "interrupted" && ledger.finalMessagePointer === undefined))
        ? "terminal_missing_final"
        : ledger.finalMessagePointer === undefined
          ? "not_available"
          : "pointer_available",
    contentUnavailable:
      availability === "connected" ? false : { reason: availability, conversationSource: "DSH session.history" },
    cursor: ledger.cursor,
    earliestCursor: ledger.earliestCursor,
    watermarks: ledger.watermarks,
    recovery:
      ledger.unrecoverableGap === undefined
        ? { state: "reconciled" }
        : { state: "unrecoverable_gap", details: ledger.unrecoverableGap },
    logPath: ledger.logPath,
    lineage,
    connection,
    workspaceClaim: workspaceClaim ?? null,
    derivation: "session.list + session.history/event-ledger + events.mux pending/queue snapshots",
  };
}

export class BridgeService {
  constructor(
    private readonly config: BridgeConfig,
    private readonly api: DshApi,
    private readonly tasks: TaskStore,
    private readonly connection: DshConnection,
    private readonly ledger: EventLedger,
    private readonly claims: WorkspaceClaimStore = new WorkspaceClaimStore(config.homeDir),
    private readonly attribution: BridgeAttributionStore = new BridgeAttributionStore(config.homeDir),
  ) {}

  private async companion(method: string, input: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    if (this.api.companion === undefined) return undefined;
    return this.api.companion(method, input);
  }

  private async registerInvocationMetadata(input: {
    runId?: string | undefined;
    taskId: string;
    rootSessionId: string;
    caller?: CallerInput | undefined;
    title?: string | undefined;
    cwd?: string | undefined;
  }): Promise<{ runId: string; submissionId: string; caller: CallerInfo; warning: string | undefined }> {
    const caller = normalizeCaller(input.caller);
    const runId = input.runId?.trim() || this.attribution.generateRunId();
    const payload = {
      runId,
      taskId: input.taskId,
      rootSessionId: input.rootSessionId,
      caller,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    };
    let remoteSubmissionId: string | undefined;
    let warning: string | undefined;
    try {
      const registered = await this.companion("registerInvocation", payload);
      remoteSubmissionId = typeof registered?.submissionId === "string" ? registered.submissionId : undefined;
    } catch (error) {
      warning = `Agentlink companion invocation registration failed; local attribution was kept: ${String(error)}`;
    }
    try {
      const local = await this.attribution.registerInvocation({
        ...payload,
        ...(remoteSubmissionId === undefined ? {} : { submissionId: remoteSubmissionId }),
      });
      return { runId, submissionId: local.submission.submissionId, caller, warning };
    } catch (error) {
      return {
        runId,
        submissionId: remoteSubmissionId ?? this.attribution.generateSubmissionId(),
        caller,
        warning: warningJoin(warning, `local attribution registration failed: ${String(error)}`),
      };
    }
  }

  private async ensureHistoricalAttribution(task: TaskRecord): Promise<void> {
    if ((await this.attribution.task(task.taskId)) !== undefined) return;
    let runId: string | undefined;
    let caller = normalizeCaller(undefined);
    try {
      const summary = await this.companion("summary", { sessionId: task.sessionId });
      runId = typeof summary?.runId === "string" ? summary.runId : undefined;
      caller = callerFromCompanion(summary?.caller) ?? caller;
    } catch {
      // Historical attribution is best-effort migration metadata. Read tools must not fail because the companion is absent or stale.
    }
    await this.attribution.registerHistoricalInvocation({
      taskId: task.taskId,
      rootSessionId: task.sessionId,
      caller,
      ...(runId === undefined ? {} : { runId }),
    });
  }

  private async registerSubmissionMetadata(input: {
    taskId: string;
    rootSessionId: string;
    caller?: CallerInput | undefined;
  }): Promise<{ runId: string; submissionId: string; caller: CallerInfo; warning: string | undefined }> {
    let existing = await this.attribution.task(input.taskId);
    if (existing === undefined) {
      await this.ensureHistoricalAttribution({ taskId: input.taskId, sessionId: input.rootSessionId });
      existing = await this.attribution.task(input.taskId);
    }
    if (existing === undefined) {
      return this.registerInvocationMetadata({
        taskId: input.taskId,
        rootSessionId: input.rootSessionId,
        ...(input.caller === undefined ? {} : { caller: input.caller }),
      });
    }
    const caller = normalizeCaller(input.caller);
    const payload = {
      runId: existing.runId,
      taskId: input.taskId,
      sessionId: input.rootSessionId,
      caller,
    };
    let remoteSubmissionId: string | undefined;
    let warning: string | undefined;
    try {
      const registered = await this.companion("registerSubmission", payload);
      remoteSubmissionId = typeof registered?.submissionId === "string" ? registered.submissionId : undefined;
    } catch (error) {
      warning = `Agentlink companion submission registration failed; local attribution was kept: ${String(error)}`;
    }
    try {
      const local = await this.attribution.registerSubmission({
        ...payload,
        ...(remoteSubmissionId === undefined ? {} : { submissionId: remoteSubmissionId }),
      });
      return { runId: existing.runId, submissionId: local.submissionId, caller, warning };
    } catch (error) {
      return {
        runId: existing.runId,
        submissionId: remoteSubmissionId ?? this.attribution.generateSubmissionId(),
        caller,
        warning: warningJoin(warning, `local attribution registration failed: ${String(error)}`),
      };
    }
  }

  private async closeSubmissionMetadata(
    submissionId: string,
    status: "finished" | "cancelled" | "failed",
  ): Promise<string | undefined> {
    let warning: string | undefined;
    try {
      await this.companion("closeSubmission", { submissionId, status });
    } catch (error) {
      warning = `Agentlink companion submission close failed; local attribution was closed: ${String(error)}`;
    }
    try {
      await this.attribution.closeSubmission(submissionId, status);
    } catch (error) {
      warning = warningJoin(warning, `local attribution close failed: ${String(error)}`);
    }
    return warning;
  }

  async costSummary(taskId: string): Promise<Record<string, unknown>> {
    const task = await this.tasks.get(taskId);
    const attribution = await this.attribution.task(taskId);
    if (this.api.companion === undefined) {
      return {
        available: false,
        reason: "companion_unavailable",
        ...(attribution === undefined ? {} : { runId: attribution.runId, sessionId: task.sessionId }),
      };
    }
    try {
      const summary = await this.companion("summary", {
        sessionId: task.sessionId,
        ...(attribution?.runId === undefined ? {} : { runId: attribution.runId }),
      });
      return { available: true, summary };
    } catch (error) {
      return {
        available: false,
        reason: "companion_summary_failed",
        message: error instanceof Error ? error.message : String(error),
        ...(attribution === undefined ? {} : { runId: attribution.runId, sessionId: task.sessionId }),
      };
    }
  }

  private async preflightWrite(taskId: string, preconditions: WritePreconditions = {}, requireWorkspaceClaim = false) {
    const task = await this.tasks.get(taskId);
    const workspaceClaim = await this.claims.get(taskId);
    if (
      workspaceClaim !== undefined &&
      (workspaceClaim.taskId !== task.taskId || workspaceClaim.sessionId !== task.sessionId)
    ) {
      throw new StaleViewError("workspace claim ownership does not match the task mapping", {
        task,
        workspaceClaim,
      });
    }
    if (requireWorkspaceClaim && workspaceClaim === undefined) {
      throw new BridgeCapabilityError(
        "workspace_claim_missing",
        "this mutation requires an active workspace claim; create a new delegation or reacquire a dedicated worktree",
        { taskId, rootSessionId: task.sessionId },
      );
    }
    const beforeConnection = this.connection.snapshot();
    if (beforeConnection.availability !== "connected") {
      throw new BridgeCapabilityError("host_unreachable", "cannot mutate a DSH session while its Host is unavailable", {
        taskId,
        availability: beforeConnection.availability,
      });
    }
    if (
      preconditions.expectedRevision !== undefined &&
      preconditions.expectedRevision !== beforeConnection.revision
    ) {
      throw new StaleViewError("the DSH connection view changed before the write preflight", {
        taskId,
        expectedRevision: preconditions.expectedRevision,
        currentRevision: beforeConnection.revision,
      });
    }

    await this.connection.refreshLineage();
    await this.connection.reconcileTask(taskId);
    const connection = this.connection.snapshot();
    if (connection.availability !== "connected") {
      throw new BridgeCapabilityError("host_unreachable", "the DSH Host became unavailable during write preflight", {
        taskId,
        availability: connection.availability,
      });
    }
    const lineage = this.connection.lineageForTask(taskId);
    const root = lineage.find((row) => row.sessionId === task.sessionId);
    if (root?.found !== true) {
      throw new BridgeCapabilityError("session_not_found", "the mapped root session is not present on the connected DSH Host", {
        taskId,
        rootSessionId: task.sessionId,
      });
    }
    if (preconditions.expectedRevision !== undefined && preconditions.expectedRevision !== connection.revision) {
      throw new StaleViewError("the DSH connection view changed during write preflight", {
        taskId,
        expectedRevision: preconditions.expectedRevision,
        currentRevision: connection.revision,
      });
    }

    const ledger = await this.ledger.snapshot(taskId);
    let changesSinceView: unknown[] = [];
    if (preconditions.sinceCursor !== undefined) {
      const delta = await this.ledger.tail(taskId, preconditions.sinceCursor, 500, 1_000_000);
      changesSinceView = delta.records;
      if (ledger.cursor > preconditions.sinceCursor) {
        throw new StaleViewError("the task changed since the caller's cursor; inspect changes and retry from the new view", {
          taskId,
          sinceCursor: preconditions.sinceCursor,
          currentCursor: ledger.cursor,
          currentRevision: connection.revision,
          changes: changesSinceView,
        });
      }
    }
    return { task, connection, ledger, lineage, workspaceClaim, changesSinceView };
  }

  private async readPointedHistory(
    taskId: string,
    pointers: LedgerEventPointer[],
  ): Promise<Map<string, DshHistoryEntry>> {
    const wantedBySession = new Map<string, Set<number>>();
    for (const pointer of pointers) {
      const wanted = wantedBySession.get(pointer.sessionId) ?? new Set<number>();
      wanted.add(pointer.seq);
      wantedBySession.set(pointer.sessionId, wanted);
    }
    const found = new Map<string, DshHistoryEntry>();
    await Promise.all(
      [...wantedBySession].map(async ([sessionId, wanted]) => {
        let beforeSeq: number | undefined;
        for (let page = 0; page < 10_000 && wanted.size > 0; page += 1) {
          const history = await this.connection.readSessionHistory(taskId, sessionId, {
            ...(beforeSeq === undefined ? {} : { beforeSeq }),
            maxMessages: 50,
          });
          for (const entry of history.events) {
            if (!wanted.has(entry.event.seq)) continue;
            found.set(`${sessionId}:${entry.event.seq}`, entry);
            wanted.delete(entry.event.seq);
          }
          const firstSeq = history.events[0]?.event.seq;
          if (!history.hasMore || firstSeq === undefined) break;
          beforeSeq = firstSeq;
        }
      }),
    );
    return found;
  }

  private async resolveFinalMessage(taskId: string, pointer: LedgerEventPointer | undefined) {
    if (pointer === undefined) return { finalMessage: null, finalMessagePointer: null };
    const entries = await this.readPointedHistory(taskId, [pointer]);
    const entry = entries.get(`${pointer.sessionId}:${pointer.seq}`);
    if (entry === undefined || entry.event.type !== "assistant/message") {
      return {
        finalMessage: null,
        finalMessagePointer: pointer,
        contentUnavailable: { reason: "history_event_not_found", pointer },
      };
    }
    return {
      finalMessage: contentText(asObject(entry.event.data)?.message) ?? null,
      finalMessagePointer: pointer,
    };
  }

  private async hydrateTail(taskId: string, records: TailDigestRecord[]): Promise<TailDigestRecord[]> {
    const pointers = records.flatMap((record) =>
      record.type === "session/event" && record.sourceSeq !== undefined
        ? [{ sessionId: record.sourceSessionId, seq: record.sourceSeq }]
        : [],
    );
    if (pointers.length === 0) return records;
    const entries = await this.readPointedHistory(taskId, pointers);
    return records.map((record) => {
      if (record.type !== "session/event" || record.sourceSeq === undefined) return record;
      const entry = entries.get(`${record.sourceSessionId}:${record.sourceSeq}`);
      if (entry === undefined) {
        return {
          ...record,
          digest: { coordination: record.digest, contentUnavailable: { reason: "history_event_not_found" } },
        };
      }
      return {
        ...record,
        digest: {
          ...((asObject(record.digest) ?? {}) as Record<string, unknown>),
          ...((asObject(historyDigest(entry)) ?? {}) as Record<string, unknown>),
        },
      };
    });
  }

  private boundTailContent(records: TailDigestRecord[], maxBytes: number): TailDigestRecord[] {
    let used = 0;
    return records.map((record) => {
      const size = Buffer.byteLength(JSON.stringify(record), "utf8");
      if (used + size <= maxBytes) {
        used += size;
        return record;
      }
      if (record.protected) {
        used += size;
        return { ...record, exceededMaxBytes: true };
      }
      return {
        ...record,
        digest: { omitted: "digest_exceeds_maxBytes", type: record.type },
        exceededMaxBytes: true,
      };
    });
  }

  async syncAttribution(): Promise<{ scanned: number; registered: number; skipped: number; warnings: string[] }> {
    const tasks = await this.tasks.list();
    const warnings: string[] = [];
    let registered = 0;
    let skipped = 0;
    for (const task of tasks) {
      try {
        let local = await this.attribution.task(task.taskId);
        if (local === undefined) {
          await this.ensureHistoricalAttribution(task);
          local = await this.attribution.task(task.taskId);
        }
        if (local === undefined) {
          skipped += 1;
          warnings.push(`skipped ${task.taskId}: local attribution unavailable`);
          continue;
        }
        if (local.rootSessionId !== task.sessionId) {
          skipped += 1;
          warnings.push(`skipped ${task.taskId}: attribution root session mismatch`);
          continue;
        }
        if (local.historical !== true) {
          skipped += 1;
          continue;
        }
        if (this.api.companion === undefined) {
          skipped += 1;
          continue;
        }
        await this.companion("registerInvocation", {
          runId: local.runId,
          taskId: local.taskId,
          rootSessionId: local.rootSessionId,
          caller: local.caller,
          ...(local.title === undefined ? {} : { title: local.title }),
          ...(local.cwd === undefined ? {} : { cwd: local.cwd }),
          historical: true,
          closeMode: "turn-end",
        });
        registered += 1;
      } catch (error) {
        skipped += 1;
        warnings.push(`sync ${task.taskId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { scanned: tasks.length, registered, skipped, warnings };
  }

  async hostStatus() {
    const connection = this.connection.snapshot();
    return {
      reachable: connection.availability === "connected",
      availability: connection.availability,
      baseUrl: this.config.hostUrl,
      connection,
      connectOnly: true,
      lifecycleOwnership: "user-or-os-service",
      startCommand: hostStartCommand(this.config.hostUrl),
    };
  }

  async delegate(input: DelegateInput) {
    const prompt = input.prompt.trim();
    if (prompt === "") throw new Error("prompt must not be empty");
    if (!isAbsolute(input.cwd)) throw new Error("cwd must be an absolute path");
    const requestedCwd = resolve(input.cwd);
    const cwd = await realpath(requestedCwd).catch((error: unknown) => {
      throw new Error(`cwd does not exist or cannot be resolved: ${requestedCwd}`, { cause: error });
    });
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
    const waitSeconds = input.waitSeconds ?? 0;
    this.validateWaitSeconds(waitSeconds);

    await this.api.hostDescribe();
    const agentPreset = input.agentPreset?.trim() || this.config.defaultAgentPreset;
    const created = await this.api.sessionCreate({ cwd, ...(agentPreset === undefined ? {} : { agentPreset }) });

    let task: TaskRecord;
    try {
      task = await this.tasks.create(created.sessionId);
    } catch (error) {
      throw new DelegationSetupError(
        "mapping",
        `DSH root session ${created.sessionId} was created, but its bridge task mapping could not be saved`,
        created.sessionId,
        undefined,
        { cause: error },
      );
    }
    await this.connection.trackTask(task);
    const workspaceMode = input.workspaceMode ?? "exclusive-write";
    let workspaceClaim;
    try {
      workspaceClaim = await this.claims.acquire({
        canonicalCwd: cwd,
        taskId: task.taskId,
        sessionId: task.sessionId,
        mode: workspaceMode,
      });
    } catch (error) {
      if (error instanceof WorkspaceClaimConflictError) {
        throw new WorkspaceClaimConflictError(
          error.code,
          `${error.message}; DSH session ${created.sessionId} and task mapping ${task.taskId} exist but were not prompted`,
          { ...error.details, taskId: task.taskId, rootSessionId: created.sessionId },
          { cause: error },
        );
      }
      throw new DelegationSetupError(
        "workspace-claim",
        `DSH root session ${created.sessionId} exists as task ${task.taskId}, but its workspace claim could not be saved`,
        created.sessionId,
        task.taskId,
        { cause: error },
      );
    }
    const beforePrompt = await this.ledger.snapshot(task.taskId);

    let models;
    try {
      models = await this.api.sessionModels(created.sessionId);
    } catch (error) {
      throw new DelegationSetupError(
        "models",
        `DSH root session ${created.sessionId} exists as task ${task.taskId}, but its model route could not be verified`,
        created.sessionId,
        task.taskId,
        { cause: error },
      );
    }
    if (!models.routable) {
      throw new DelegationSetupError(
        "models",
        `DSH root session ${created.sessionId} selected ${formatModel(models.current)}, but its provider is not routable (task ${task.taskId})`,
        created.sessionId,
        task.taskId,
      );
    }

    const attribution = await this.registerInvocationMetadata({
      taskId: task.taskId,
      rootSessionId: created.sessionId,
      cwd,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.caller === undefined ? {} : { caller: input.caller }),
      ...(input.title === undefined ? {} : { title: input.title }),
    });
    let promptTrackingWarning: string | undefined;
    let promptIssuedRpcId: string | undefined;
    try {
      const promptReceipt = await this.api.sessionPrompt(promptPayload(this.config, created.sessionId, prompt, "queue"));
      const issuedRpcId = getDshUnaryMetadata(promptReceipt).issuedRpcId;
      promptIssuedRpcId = issuedRpcId;
      await this.ledger
        .append(task.taskId, {
          sourceSessionId: created.sessionId,
          origin: "root",
          type: "bridge/prompt-issued",
          raw: { issuedRpcId, mode: "queue" },
        })
        .catch((error: unknown) => {
          promptTrackingWarning = `prompt was accepted as rpcId ${issuedRpcId}, but coordination metadata could not be recorded: ${String(error)}`;
        });
    } catch (error) {
      await this.closeSubmissionMetadata(attribution.submissionId, "failed");
      throw new DelegationSetupError(
        "prompt",
        `DSH root session ${created.sessionId} exists as task ${task.taskId}, but the initial prompt was not accepted`,
        created.sessionId,
        task.taskId,
        { cause: error },
      );
    }

    let renameWarning: string | undefined;
    try {
      await this.api.sessionRename(created.sessionId, input.title?.trim() || deriveTitle(prompt));
    } catch (error) {
      renameWarning = `session started, but automatic rename failed: ${String(error)}`;
    }
    const base = {
      taskId: task.taskId,
      rootSessionId: task.sessionId,
      runId: attribution.runId,
      submissionId: attribution.submissionId,
      caller: attribution.caller,
      accepted: true,
      detached: waitSeconds === 0,
      model: models.current,
      routable: models.routable,
      ...(promptIssuedRpcId === undefined ? {} : { issuedRpcId: promptIssuedRpcId }),
      baseUrl: this.config.hostUrl,
      workspaceClaim,
      ...(warningJoin(attribution.warning, promptTrackingWarning) === undefined
        ? {}
        : { coordinationWarning: warningJoin(attribution.warning, promptTrackingWarning) }),
      ...(renameWarning === undefined ? {} : { warning: renameWarning }),
    };
    if (waitSeconds === 0) return base;
    return { ...base, wait: await this.wait(task.taskId, waitSeconds, beforePrompt.cursor) };
  }

  async continueTask(
    taskId: string,
    prompt: string,
    mode: "queue" | "steer" = "queue",
    preconditions: WritePreconditions = {},
    caller?: CallerInput,
  ) {
    const trimmed = prompt.trim();
    if (trimmed === "") throw new Error("prompt must not be empty");
    const view = await this.preflightWrite(taskId, preconditions, true);
    const { task } = view;
    const models = await this.api.sessionModels(task.sessionId);
    if (!models.routable) {
      throw new BridgeCapabilityError(
        "model_unroutable",
        `the root session's current route ${formatModel(models.current)} is not routable`,
        { taskId, rootSessionId: task.sessionId, current: models.current },
      );
    }
    const attribution = await this.registerSubmissionMetadata({
      taskId,
      rootSessionId: task.sessionId,
      ...(caller === undefined ? {} : { caller }),
    });
    let receipt;
    try {
      receipt = await this.api.sessionPrompt(promptPayload(this.config, task.sessionId, trimmed, mode));
    } catch (error) {
      await this.closeSubmissionMetadata(attribution.submissionId, "failed");
      throw error;
    }
    const issuedRpcId = getDshUnaryMetadata(receipt).issuedRpcId;
    let coordinationWarning: string | undefined;
    await this.ledger
      .append(taskId, {
        sourceSessionId: task.sessionId,
        origin: "root",
        type: "bridge/prompt-issued",
        raw: { issuedRpcId, mode },
      })
      .catch((error: unknown) => {
        coordinationWarning = `prompt was accepted, but issued rpcId metadata could not be recorded: ${String(error)}`;
      });
    return {
      taskId,
      rootSessionId: task.sessionId,
      runId: attribution.runId,
      submissionId: attribution.submissionId,
      caller: attribution.caller,
      mode,
      deliveryTarget: mode === "queue" ? "next-turn" : "next-step",
      durableWhenClaimedByDsh: true,
      model: models.current,
      routable: models.routable,
      issuedRpcId,
      accepted: receipt.accepted,
      ...(receipt.command === undefined ? {} : { command: receipt.command }),
      ...(warningJoin(attribution.warning, coordinationWarning) === undefined
        ? {}
        : { coordinationWarning: warningJoin(attribution.warning, coordinationWarning) }),
      preflight: {
        cursor: view.ledger.cursor,
        connectionRevision: view.connection.revision,
        changesSinceView: view.changesSinceView,
      },
    };
  }

  async status(taskId: string) {
    const task = await this.tasks.get(taskId);
    await this.ensureHistoricalAttribution(task).catch(() => undefined);
    const attribution = await this.attribution.task(taskId);
    const workspaceClaim = await this.claims.get(taskId);
    let ledger = await this.ledger.snapshot(taskId);
    let connection = this.connection.snapshot();
    let lineage = this.connection.lineageForTask(taskId);
    let pending = this.connection.pendingForTask(taskId);
    let queue = this.connection.queueForSession(task.sessionId);
    let pendingExecution = interactionExecution(pending);
    if (connection.availability !== "connected") {
      return {
        ...statusShape(
          task,
          connection,
          ledger,
          lineage,
          "host_unreachable",
          ledger.execution,
          [],
          queue,
          workspaceClaim,
          attribution,
        ),
        lastKnownPendingInteractions: ledger.pendingInteractions,
      };
    }

    try {
      await this.connection.refreshLineage();
      connection = this.connection.snapshot();
      lineage = this.connection.lineageForTask(taskId);
      pending = this.connection.pendingForTask(taskId);
      pendingExecution = interactionExecution(pending);
      queue = this.connection.queueForSession(task.sessionId);
      const root = lineage.find((row) => row.sessionId === task.sessionId);
      if (root?.found !== true) {
        const missingQueue: QueueSnapshot = {
          known: false,
          stale: false,
          connectionEpoch: connection.connectionEpoch,
          items: [],
        };
        return {
          ...statusShape(task, connection, ledger, lineage, "session_not_found", ledger.execution, [], missingQueue, workspaceClaim, attribution),
          running: null,
          blank: null,
        };
      }
      await this.connection.reconcileTask(taskId);
      ledger = await this.ledger.snapshot(taskId);
      connection = this.connection.snapshot();
      pending = this.connection.pendingForTask(taskId);
      pendingExecution = interactionExecution(pending);
      queue = this.connection.queueForSession(task.sessionId);
      const models = await this.api.sessionModels(task.sessionId);
      let execution =
        pendingExecution ??
        (root.running === true
          ? "running"
          : root.blank === true
            ? "starting"
            : ledger.execution === "running"
              ? "interrupted"
              : ledger.execution);
      if (execution === "interrupted" && ledger.execution === "running") {
        await this.ledger.append(taskId, {
          sourceSessionId: task.sessionId,
          origin: "root",
          type: "bridge/turn-interrupted",
          raw: {
            reason: "host-reported-no-active-turn-after-history-reconciliation",
            connectionEpoch: connection.connectionEpoch,
            ...(ledger.currentTurn === undefined ? {} : { turnStartCursor: ledger.currentTurn.startCursor }),
          },
        });
        ledger = await this.ledger.snapshot(taskId);
        execution = ledger.execution;
      }
      const final = await this.resolveFinalMessage(taskId, ledger.finalMessagePointer);
      const result = {
        ...statusShape(
          task,
          connection,
          ledger,
          lineage,
          "connected",
          execution,
          pending,
          this.connection.queueForSession(task.sessionId),
          workspaceClaim,
          attribution,
        ),
        ...final,
        finalMessageStatus:
          isTerminal(execution) &&
          (ledger.terminalMissingFinal || (execution === "interrupted" && ledger.finalMessagePointer === undefined))
            ? "terminal_missing_final"
            : final.finalMessage === null
              ? "not_available"
              : "available",
        contentUnavailable: "contentUnavailable" in final ? final.contentUnavailable : false,
        running: root.running ?? false,
        blank: root.blank ?? false,
        model: models.current,
        routable: models.routable,
      };
      return result;
    } catch (error) {
      if (error instanceof DshRpcError && error.code === "session-not-found") {
        const missingQueue: QueueSnapshot = {
          known: false,
          stale: false,
          connectionEpoch: connection.connectionEpoch,
          items: [],
        };
        return {
          ...statusShape(task, connection, ledger, lineage, "session_not_found", ledger.execution, [], missingQueue, workspaceClaim, attribution),
          running: null,
          blank: null,
        };
      }
      if (error instanceof DshTransportError) {
        return {
          ...statusShape(
            task,
            this.connection.snapshot(),
            ledger,
            lineage,
            "host_unreachable",
            ledger.execution,
            [],
            queue,
            workspaceClaim,
            attribution,
          ),
          lastKnownPendingInteractions: ledger.pendingInteractions,
        };
      }
      throw error;
    }
  }

  async tail(
    taskId: string,
    sinceCursor = 0,
    maxEvents = 50,
    maxBytes = 64_000,
    kinds: TailKind[] = ["attention"],
    sessionIds?: string[],
  ) {
    const status = await this.status(taskId);
    let tail = await this.ledger.tail(taskId, sinceCursor, 500, 1_000_000);
    const filtered: TailDigestRecord[] = [];
    let scanCursor = sinceCursor;
    let hasMore = tail.hasMore;
    while (true) {
      for (const record of tail.records) {
        const sessionMatches = sessionIds === undefined || sessionIds.includes(record.sourceSessionId);
        if (sessionMatches && tailMatches(record, kinds)) {
          if (filtered.length >= maxEvents) {
            hasMore = true;
            break;
          }
          filtered.push(record);
          scanCursor = record.cursor;
          continue;
        }
        scanCursor = record.cursor;
      }
      if (filtered.length >= maxEvents || !tail.hasMore || tail.records.length === 0) break;
      tail = await this.ledger.tail(taskId, scanCursor, 500, 1_000_000);
      hasMore = tail.hasMore;
    }
    let events = filtered;
    let contentUnavailable: false | { reason: string; message?: string } =
      status.availability === "connected"
        ? false
        : { reason: status.availability };
    if (status.availability === "connected") {
      try {
        events = await this.hydrateTail(taskId, filtered);
        events = this.boundTailContent(events, maxBytes);
      } catch (error) {
        contentUnavailable = {
          reason: error instanceof DshTransportError ? "host_unreachable" : "history_unavailable",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return {
      taskId,
      events,
      nextCursor: scanCursor,
      scanCursor,
      earliestCursor: tail.earliestCursor,
      hasMore,
      contentTruncated: events.some((event) => event.exceededMaxBytes === true),
      status,
      pendingInteractions: status.pendingInteractions,
      logPath: status.logPath,
      contentUnavailable,
      contentSource: "DSH session.history (live); bridge persistence contains coordination metadata only",
      delivery: "at-least-once with deterministic (sourceSessionId, sourceSeq) dedupe",
      mergeOrder: "bridge observation/persistence order; not a DSH global causal order",
    };
  }

  async wait(taskId: string, timeoutSec: number, sinceCursor?: number, wakeOn: WaitWakeOn = "attention") {
    this.validateWaitSeconds(timeoutSec);
    const initial = await this.status(taskId);
    const cursor = sinceCursor ?? initial.cursor;
    if (cursor < initial.earliestCursor - 1) {
      await this.ledger.tail(taskId, cursor, 1, 1);
    }
    const initialReason =
      wakeOn === "activity" && initial.cursor > cursor
        ? "activity"
        : waitAttentionReason(initial, cursor, sinceCursor !== undefined);
    if (initialReason !== undefined) {
      return { timedOut: false, reason: initialReason, status: initial, nextCursor: initial.cursor };
    }
    if (timeoutSec === 0) return { timedOut: true, reason: "timeout", status: initial, nextCursor: initial.cursor };
    const deadline = Date.now() + timeoutSec * 1_000;
    let status = initial;
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return { timedOut: true, reason: "timeout", status, nextCursor: status.cursor };
      const change = await this.connection.waitForTaskChange(taskId, cursor, initial.connection.revision, remainingMs);
      status = await this.status(taskId);
      const reason =
        wakeOn === "activity" && status.cursor > cursor
          ? "activity"
          : waitAttentionReason(status, cursor, sinceCursor !== undefined);
      if (reason !== undefined) return { timedOut: false, reason, status, nextCursor: status.cursor };
      if (change.timedOut) return { timedOut: true, reason: "timeout", status, nextCursor: status.cursor };
    }
  }

  async observe(taskId: string, afterCursor: number | undefined, waitSeconds: number) {
    return {
      deprecatedAlias: "dsh_observe is a compatibility alias; prefer dsh_wait/dsh_tail task cursors",
      ...(await this.wait(taskId, waitSeconds, afterCursor)),
    };
  }

  async cancel(
    taskId: string,
    scope: "turn" | "queue" = "turn",
    preconditions: WritePreconditions = {},
  ) {
    const view = await this.preflightWrite(taskId, preconditions);
    const { task } = view;
    if (scope === "turn") {
      const receipt = await this.api.sessionCancel(task.sessionId);
      const issuedRpcId = getDshUnaryMetadata(receipt).issuedRpcId;
      return {
        taskId,
        rootSessionId: task.sessionId,
        scope: "turn",
        queuedMessagesPreserved: true,
        runInBackgroundJobsPreserved: true,
        cancellationBoundary:
          "DSH aborts the active turn; foreground tools must honor AbortSignal. Built-in foreground shell escalates SIGTERM to SIGKILL, but background jobs require job_kill.",
        preflight: { cursor: view.ledger.cursor, connectionRevision: view.connection.revision },
        accepted: receipt.accepted,
        issuedRpcId,
      };
    }

    const snapshot = this.connection.queueForSession(task.sessionId);
    if (!snapshot.known || snapshot.stale) {
      throw new BridgeCapabilityError(
        "queue_snapshot_unavailable",
        "cannot clear the queue without a current events.mux session/queue baseline",
        { taskId, rootSessionId: task.sessionId, snapshot },
      );
    }
    const requested = snapshot.items.map((item) => item.id);
    const removed: string[] = [];
    const alreadyClaimed: string[] = [];
    const failed: Array<{ itemId: string; error: unknown }> = [];
    for (const itemId of requested) {
      try {
        await this.api.sessionUpdateQueue(task.sessionId, itemId, { kind: "remove" });
        removed.push(itemId);
      } catch (error) {
        if (error instanceof DshRpcError && error.code === "queue-item-not-found") {
          alreadyClaimed.push(itemId);
        } else {
          failed.push({
            itemId,
            error:
              error instanceof DshRpcError
                ? { name: error.name, code: error.code, message: error.message, details: error.details }
                : { name: error instanceof Error ? error.name : "UnknownError", message: String(error) },
          });
        }
      }
    }
    return {
      taskId,
      rootSessionId: task.sessionId,
      scope: "queue",
      nonAtomic: true,
      requested,
      removed,
      alreadyClaimed,
      failed,
      preflight: { cursor: view.ledger.cursor, connectionRevision: view.connection.revision },
      note: "Each rc.6 session.updateQueue(remove) is independent; an item can be claimed between snapshot and removal.",
    };
  }

  async answerQuestion(
    taskId: string,
    requestId: string,
    answers: DshQuestionAnswer[],
    preconditions: WritePreconditions = {},
  ) {
    await this.preflightWrite(taskId, preconditions, true);
    return this.connection.answerQuestion(taskId, requestId, answers);
  }

  async resolveApproval(
    taskId: string,
    requestId: string,
    outcome: "allow_once" | "reject",
    preconditions: WritePreconditions = {},
  ) {
    await this.preflightWrite(taskId, preconditions, outcome === "allow_once");
    return this.connection.resolveApproval(taskId, requestId, outcome);
  }

  async releaseWorkspace(taskId: string) {
    const task = await this.tasks.get(taskId);
    const released = await this.claims.release(taskId);
    return {
      taskId,
      rootSessionId: task.sessionId,
      released,
      sessionClosedByRelease: false,
      sessionExistence: "not_checked",
      warning:
        "Releasing the bridge claim does not close the DSH session or prevent DSH Web/Codex shell edits. Do not continue this session against the released workspace unless a new isolated worktree/claim is established.",
    };
  }

  async listTasks() {
    const tasks = await this.tasks.list();
    const connection = this.connection.snapshot();
    return Promise.all(
      tasks.map(async (task) => {
        try {
          await this.ensureHistoricalAttribution(task).catch(() => undefined);
          const attribution = await this.attribution.task(task.taskId);
          const ledger = await this.ledger.snapshot(task.taskId);
          const workspaceClaim = await this.claims.get(task.taskId);
          const availability = connection.availability === "connected" ? "connected" : "host_unreachable";
          const pending = connection.availability === "connected" ? this.connection.pendingForTask(task.taskId) : [];
          const queue =
            connection.availability === "connected"
              ? this.connection.queueForSession(task.sessionId)
              : { known: false, stale: false, connectionEpoch: connection.connectionEpoch, items: [] };
          return statusShape(
            task,
            connection,
            ledger,
            connection.availability === "connected" ? this.connection.lineageForTask(task.taskId) : [],
            availability,
            interactionExecution(pending) ?? ledger.execution,
            pending,
            queue,
            workspaceClaim,
            attribution,
          );
        } catch (error) {
          return {
            taskId: task.taskId,
            rootSessionId: task.sessionId,
            availability: "host_unreachable",
            status: "unknown",
            error: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
          };
        }
      }),
    );
  }

  private validateWaitSeconds(waitSeconds: number): void {
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 30) {
      throw new Error("waitSeconds/timeoutSec must be an integer between 0 and 30");
    }
  }
}
