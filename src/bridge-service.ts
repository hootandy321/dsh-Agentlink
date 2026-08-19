import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

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
import type { TaskRecord } from "./task-store.js";
import { TaskStore } from "./task-store.js";
import type { WorkspaceClaimMode } from "./workspace-claim.js";
import { WorkspaceClaimConflictError, WorkspaceClaimStore } from "./workspace-claim.js";

export interface DelegateInput {
  prompt: string;
  cwd: string;
  agentPreset?: string;
  title?: string;
  waitSeconds?: number;
  workspaceMode?: WorkspaceClaimMode;
}

export interface WritePreconditions {
  sinceCursor?: number;
  expectedRevision?: number;
}

export type TaskAvailability = "connected" | "host_unreachable" | "session_not_found";

export interface WorkspaceClaimSemantics {
  enforcement: "bridge-cooperative-only";
  controlsDshSandbox: false;
  description: string;
}

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
      | "preset_not_found"
      | "preset_broken"
      | "resolved_preset_mismatch"
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

function workspaceClaimSemantics(): WorkspaceClaimSemantics {
  return {
    enforcement: "bridge-cooperative-only",
    controlsDshSandbox: false,
    description:
      "workspaceMode is a bridge-local coordination claim shared only by bridge processes using the same bridge home; it does not select, enforce, or verify the DSH Host filesystem sandbox.",
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
) {
  return {
    taskId: task.taskId,
    rootSessionId: task.sessionId,
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
    workspaceClaimSemantics: workspaceClaimSemantics(),
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
  ) {}

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
    const requestedPreset = input.agentPreset?.trim();
    const selectedPreset = requestedPreset || this.config.defaultAgentPreset;
    const selectionMode: "manual" | "dsh-default" = selectedPreset === undefined ? "dsh-default" : "manual";
    let verification: "not-required" | "verified" | "unavailable";
    let resolvedPreset: string | undefined;

    if (selectionMode === "manual" && selectedPreset !== undefined) {
      const roster = await this.api.agentPresetList();
      const entry = roster.presets.find((preset) => preset.id === selectedPreset);
      if (entry === undefined) {
        throw new BridgeCapabilityError(
          "preset_not_found",
          `requested agent preset "${selectedPreset}" is not in the DSH preset roster`,
          { requestedPreset: selectedPreset, promptSent: false },
        );
      }
      if (entry.broken !== undefined) {
        throw new BridgeCapabilityError(
          "preset_broken",
          `requested agent preset "${selectedPreset}" is marked broken and cannot be launched`,
          { requestedPreset: selectedPreset, presetId: entry.id, promptSent: false },
        );
      }
    }

    const created = await this.api.sessionCreate({
      cwd,
      ...(selectedPreset === undefined ? {} : { agentPreset: selectedPreset }),
    });

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

    if (selectionMode === "manual") {
      if (created.agentPreset === undefined) {
        verification = "unavailable";
      } else if (created.agentPreset === selectedPreset) {
        verification = "verified";
        resolvedPreset = created.agentPreset;
      } else {
        throw new BridgeCapabilityError(
          "resolved_preset_mismatch",
          `requested agent preset "${selectedPreset}" resolved to "${created.agentPreset}" on the DSH session`,
          {
            taskId: task.taskId,
            rootSessionId: task.sessionId,
            sessionId: created.sessionId,
            requestedPreset: selectedPreset,
            resolvedPreset: created.agentPreset,
            promptSent: false,
          },
        );
      }
    } else {
      verification = "not-required";
      resolvedPreset = created.agentPreset;
    }

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
      accepted: true,
      detached: waitSeconds === 0,
      model: models.current,
      routable: models.routable,
      selectionMode,
      verification,
      ...(selectedPreset === undefined ? {} : { requestedPreset: selectedPreset }),
      ...(resolvedPreset === undefined ? {} : { resolvedPreset }),
      ...(promptIssuedRpcId === undefined ? {} : { issuedRpcId: promptIssuedRpcId }),
      baseUrl: this.config.hostUrl,
      workspaceClaim,
      workspaceClaimSemantics: workspaceClaimSemantics(),
      ...(promptTrackingWarning === undefined ? {} : { coordinationWarning: promptTrackingWarning }),
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
    const receipt = await this.api.sessionPrompt(promptPayload(this.config, task.sessionId, trimmed, mode));
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
      mode,
      deliveryTarget: mode === "queue" ? "next-turn" : "next-step",
      durableWhenClaimedByDsh: true,
      model: models.current,
      routable: models.routable,
      issuedRpcId,
      accepted: receipt.accepted,
      ...(receipt.command === undefined ? {} : { command: receipt.command }),
      ...(coordinationWarning === undefined ? {} : { coordinationWarning }),
      preflight: {
        cursor: view.ledger.cursor,
        connectionRevision: view.connection.revision,
        changesSinceView: view.changesSinceView,
      },
    };
  }

  async status(taskId: string) {
    const task = await this.tasks.get(taskId);
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
          ...statusShape(task, connection, ledger, lineage, "session_not_found", ledger.execution, [], missingQueue, workspaceClaim),
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
      return {
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
    } catch (error) {
      if (error instanceof DshRpcError && error.code === "session-not-found") {
        const missingQueue: QueueSnapshot = {
          known: false,
          stale: false,
          connectionEpoch: connection.connectionEpoch,
          items: [],
        };
        return {
          ...statusShape(task, connection, ledger, lineage, "session_not_found", ledger.execution, [], missingQueue, workspaceClaim),
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
          ),
          lastKnownPendingInteractions: ledger.pendingInteractions,
        };
      }
      throw error;
    }
  }

  async tail(taskId: string, sinceCursor = 0, maxEvents = 50, maxBytes = 64_000) {
    const status = await this.status(taskId);
    const tail = await this.ledger.tail(taskId, sinceCursor, maxEvents, maxBytes);
    let events = tail.records;
    let contentUnavailable: false | { reason: string; message?: string } =
      status.availability === "connected"
        ? false
        : { reason: status.availability };
    if (status.availability === "connected") {
      try {
        events = await this.hydrateTail(taskId, tail.records);
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
      nextCursor: tail.nextCursor,
      earliestCursor: tail.earliestCursor,
      hasMore: tail.hasMore,
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

  async wait(taskId: string, timeoutSec: number, sinceCursor?: number) {
    this.validateWaitSeconds(timeoutSec);
    const initial = await this.status(taskId);
    const cursor = sinceCursor ?? initial.cursor;
    if (cursor < initial.earliestCursor - 1) {
      await this.ledger.tail(taskId, cursor, 1, 1);
    }
    if (
      initial.cursor > cursor ||
      initial.pendingInteractions.length > 0 ||
      (initial.availability === "connected" && isTerminal(initial.execution))
    ) {
      return { timedOut: false, status: initial, nextCursor: initial.cursor };
    }
    if (timeoutSec === 0) return { timedOut: true, status: initial, nextCursor: initial.cursor };
    const change = await this.connection.waitForTaskChange(
      taskId,
      cursor,
      initial.connection.revision,
      timeoutSec * 1_000,
    );
    const status = await this.status(taskId);
    return { timedOut: change.timedOut, status, nextCursor: status.cursor };
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
    return Promise.all(
      tasks.map(async (task) => {
        try {
          return await this.status(task.taskId);
        } catch (error) {
          return {
            taskId: task.taskId,
            rootSessionId: task.sessionId,
            availability: "host_unreachable",
            status: "unknown",
            workspaceClaimSemantics: workspaceClaimSemantics(),
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
