type AnyRecord = Record<string, any>;

export const STATUS_INCLUDE_VALUES = [
  "result",
  "interactions",
  "queue",
  "workspace",
  "sessions",
  "connection",
  "recovery",
  "cost",
] as const;

export type StatusInclude = (typeof STATUS_INCLUDE_VALUES)[number];

export const TAIL_KIND_VALUES = [
  "attention",
  "turn",
  "final",
  "interaction",
  "bridge",
  "queue",
  "jobs",
  "error",
  "message",
  "all",
] as const;

export type TailKind = (typeof TAIL_KIND_VALUES)[number];

export function projectStatus(status: AnyRecord, include: StatusInclude[] = []): AnyRecord {
  const includeSet = new Set(include);
  const resultAvailable = status.finalMessageStatus === "available" || status.finalMessageStatus === "pointer_available";
  const view: AnyRecord = {
    taskId: status.taskId,
    rootSessionId: status.rootSessionId,
    ...(status.runId === undefined ? {} : { runId: status.runId }),
    availability: status.availability,
    execution: status.execution,
    status: status.status,
    lastKnownExecutionStatus: status.lastKnownExecutionStatus,
    turn: status.turn,
    cursor: status.cursor,
    earliestCursor: status.earliestCursor,
    connectionRevision: status.connection?.revision,
    pendingInteractionCount: Array.isArray(status.pendingInteractions) ? status.pendingInteractions.length : 0,
    queueDepth: status.queueDepth,
    finalMessageStatus: status.finalMessageStatus,
    resultAvailable,
    contentUnavailable: status.contentUnavailable,
    recoveryState: status.recovery?.state,
  };

  if (status.model !== undefined) view.model = status.model;
  if (status.running !== undefined) view.running = status.running;
  if (status.blank !== undefined) view.blank = status.blank;

  if (includeSet.has("result")) {
    view.finalMessage = status.finalMessage ?? null;
    view.finalMessagePointer = status.finalMessagePointer ?? null;
  }
  if (includeSet.has("interactions")) {
    view.pendingInteractions = status.pendingInteractions ?? [];
    if (status.lastKnownPendingInteractions !== undefined) {
      view.lastKnownPendingInteractions = status.lastKnownPendingInteractions;
    }
  }
  if (includeSet.has("queue")) view.queueDepth = status.queueDepth;
  if (includeSet.has("workspace")) view.workspaceClaim = status.workspaceClaim ?? null;
  if (includeSet.has("sessions")) view.lineage = status.lineage ?? [];
  if (includeSet.has("connection")) view.connection = status.connection;
  if (includeSet.has("recovery")) {
    view.recovery = status.recovery;
    view.watermarks = status.watermarks;
    view.logPath = status.logPath;
    view.derivation = status.derivation;
  }
  if (includeSet.has("cost")) view.cost = status.cost ?? null;

  return view;
}

export function projectWait(
  wait: AnyRecord,
  include: StatusInclude[] = [],
  options: { includeResult?: boolean } = {},
): AnyRecord {
  const statusInclude = new Set<StatusInclude>(include);
  if (options.includeResult === true) statusInclude.add("result");
  if (wait.reason === "pending_interaction") statusInclude.add("interactions");
  return {
    timedOut: wait.timedOut,
    reason: wait.reason ?? (wait.timedOut ? "timeout" : "changed"),
    nextCursor: wait.nextCursor,
    status: projectStatus(wait.status, [...statusInclude]),
  };
}

export function projectTail(tail: AnyRecord): AnyRecord {
  return {
    taskId: tail.taskId,
    events: tail.events ?? [],
    nextCursor: tail.nextCursor,
    scanCursor: tail.scanCursor ?? tail.nextCursor,
    earliestCursor: tail.earliestCursor,
    hasMore: tail.hasMore,
    contentTruncated: tail.contentTruncated,
    contentUnavailable: tail.contentUnavailable,
    contentSource: tail.contentSource,
    delivery: tail.delivery,
    mergeOrder: tail.mergeOrder,
  };
}

export function projectTaskList(statuses: AnyRecord[], include: StatusInclude[] = []): AnyRecord {
  return {
    tasks: statuses.map((status) => projectStatus(status, include)),
  };
}
