import type {
  DshConnection,
  HostConnectionSnapshot,
  QueueSnapshot,
  TaskChangeResult,
  TaskLineageSession,
} from "../../src/connection-manager.js";
import type { EventLedger } from "../../src/event-ledger.js";
import type {
  DshAgentPreset,
  DshAgentPresetListValue,
  DshApi,
  DshClientResponse,
  DshHostDescription,
  DshMuxFrame,
  DshPendingEnvelope,
  DshQuestionAnswer,
  DshRpcReceipt,
  DshServerRequest,
  DshSessionHistory,
  DshSessionModels,
  DshSessionSummary,
  DshSubagentAddress,
  DshSubagentListValue,
  DshUnaryResult,
} from "../../src/dsh-types.js";
import { attachDshUnaryMetadata } from "../../src/dsh-types.js";
import type { TaskRecord } from "../../src/task-store.js";

export class FakeDshApi implements DshApi {
  calls: Array<{ method: string; payload: unknown }> = [];
  description: DshHostDescription = {
    version: "0.0.1",
    cwd: "/tmp",
    attachedSessions: 0,
    canOpenPath: true,
  };
  sessions: DshSessionSummary[] = [];
  histories = new Map<string, DshSessionHistory>();
  agentPresets: DshAgentPreset[] = [];
  agentPresetAuthorable = false;
  agentPresetHasDocument = false;
  models: DshSessionModels = {
    current: { provider: "test-provider", model: "test-model" },
    routable: true,
    groups: [],
    failures: [],
  };
  respondReceipt: DshRpcReceipt = { accepted: true };
  nextSessionId = "root-session";
  /**
   * Controls the resolved agentPreset reported by `sessionCreate`:
   * - `undefined` (the default): echo the requested preset back (matching), or omit it when none was requested;
   * - a string: always report that string as the resolved preset (mismatch / DSH-default-with-observable tests);
   * - `null`: force the created session to expose no resolved preset even when one was requested (legacy/absent Host).
   */
  sessionCreateResolvedAgentPreset?: string | null = undefined;
  updateQueueErrors = new Map<string, Error>();
  private rpcSeq = 0;

  private unary<T extends object>(method: string, value: T): DshUnaryResult<T> {
    this.rpcSeq += 1;
    return attachDshUnaryMetadata(value, { issuedRpcId: `fake-rpc-${this.rpcSeq}`, method });
  }

  async hostDescribe(): Promise<DshUnaryResult<DshHostDescription>> {
    this.calls.push({ method: "host.describe", payload: {} });
    return this.unary("host.describe", this.description);
  }

  async sessionList(): Promise<DshUnaryResult<{ items: DshSessionSummary[] }>> {
    this.calls.push({ method: "session.list", payload: {} });
    return this.unary("session.list", { items: structuredClone(this.sessions) });
  }

  async sessionCreate(payload: { cwd: string; agentPreset?: string; sessionId?: string }) {
    this.calls.push({ method: "session.create", payload });
    const sessionId = payload.sessionId ?? this.nextSessionId;
    if (!this.sessions.some((item) => item.sessionId === sessionId)) {
      this.sessions.push({ sessionId, updatedAt: Date.now(), running: true, blank: false, cwd: payload.cwd });
    }
    const resolved = this.sessionCreateResolvedAgentPreset !== undefined ? this.sessionCreateResolvedAgentPreset : payload.agentPreset;
    return this.unary("session.create", {
      sessionId,
      ...(resolved === undefined || resolved === null ? {} : { agentPreset: resolved }),
    });
  }

  async sessionModels(sessionId: string) {
    this.calls.push({ method: "session.models", payload: { sessionId } });
    return this.unary("session.models", this.models);
  }

  async sessionPrompt(payload: {
    sessionId: string;
    mode: "queue" | "steer";
    content: Array<{ type: "text"; text: string }>;
    clientTimeZone?: string;
  }) {
    this.calls.push({ method: "session.prompt", payload });
    return this.unary("session.prompt", { accepted: true as const });
  }

  async sessionRename(sessionId: string, title: string) {
    this.calls.push({ method: "session.rename", payload: { sessionId, title } });
    return this.unary("session.rename", { title, seq: 1 });
  }

  async sessionHistory(sessionId: string, options: { beforeSeq?: number; maxMessages?: number } = {}) {
    this.calls.push({ method: "session.history", payload: { sessionId, ...options } });
    return this.unary("session.history", this.histories.get(sessionId) ?? { events: [], hasMore: false });
  }

  async sessionCancel(sessionId: string) {
    this.calls.push({ method: "session.cancel", payload: { sessionId } });
    return this.unary("session.cancel", { accepted: true as const });
  }

  async agentPresetList(): Promise<DshUnaryResult<DshAgentPresetListValue>> {
    this.calls.push({ method: "agentPreset.list", payload: {} });
    return this.unary("agentPreset.list", {
      presets: structuredClone(this.agentPresets),
      authorable: this.agentPresetAuthorable,
      hasDocument: this.agentPresetHasDocument,
    });
  }

  async sessionUpdateQueue(sessionId: string, itemId: string, action: { kind: "remove" }) {
    this.calls.push({ method: "session.updateQueue", payload: { sessionId, itemId, action } });
    const error = this.updateQueueErrors.get(itemId);
    if (error !== undefined) throw error;
    return this.unary("session.updateQueue", { accepted: true as const });
  }

  async subagentList(parentSessionId: string): Promise<DshUnaryResult<DshSubagentListValue>> {
    this.calls.push({ method: "subagent.list", payload: { parentSessionId } });
    return this.unary("subagent.list", { entries: [], parentAvailable: true });
  }

  async subagentHistory(address: DshSubagentAddress, options: { beforeSeq?: number; maxMessages?: number } = {}) {
    this.calls.push({ method: "subagent.history", payload: { ...address, ...options } });
    return this.unary("subagent.history", this.histories.get(address.childSessionId) ?? { events: [], hasMore: false });
  }

  async respond(message: DshClientResponse) {
    this.calls.push({ method: "respond", payload: message });
    return this.respondReceipt;
  }

  async *openMux(signal: AbortSignal, onOpen?: () => void): AsyncIterable<DshServerRequest<DshMuxFrame>> {
    onOpen?.();
    if (signal.aborted) return;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
}

export class FakeConnection implements DshConnection {
  state: HostConnectionSnapshot;
  pending: DshPendingEnvelope[] = [];
  queue: QueueSnapshot = { known: true, stale: false, connectionEpoch: 1, items: [] };
  lineage: TaskLineageSession[] = [];
  tracked: TaskRecord[] = [];
  histories = new Map<string, DshSessionHistory>();

  constructor(private readonly ledger: EventLedger, baseUrl = "http://127.0.0.1:3080") {
    this.state = {
      availability: "connected",
      baseUrl,
      connectionEpoch: 1,
      revision: 1,
      testedDshVersions: ["0.1.0-rc.6", "0.1.0-rc.7"],
      compatibility: "capability-probed",
      capabilities: {
        unaryRpc: true,
        eventsMuxWebSocket: true,
        muxResumeSince: false,
        historyReconciliation: true,
        queueSnapshot: true,
        queueEmptyBaselineInference: false,
        typedRespond: true,
        pendingReplayReconciliation: "stable-rpcid-baseline-idle",
        subagentHistory: "not-probed",
      },
    };
  }

  start(): void {}
  async stop(): Promise<void> {}
  snapshot(): HostConnectionSnapshot {
    return structuredClone(this.state);
  }
  async trackTask(task: TaskRecord): Promise<void> {
    this.tracked.push(task);
    this.lineage = [{ sessionId: task.sessionId, found: true, origin: "root", running: true, blank: false, historyCapability: "session.history" }];
  }
  async reconcileTask(): Promise<void> {}
  async refreshLineage(): Promise<void> {}
  async readSessionHistory(_taskId: string, sessionId: string): Promise<DshSessionHistory> {
    return this.histories.get(sessionId) ?? { events: [], hasMore: false };
  }
  lineageForTask(): TaskLineageSession[] {
    return structuredClone(this.lineage);
  }
  pendingForTask(): DshPendingEnvelope[] {
    return structuredClone(this.pending);
  }
  queueForSession(): QueueSnapshot {
    return structuredClone(this.queue);
  }
  async waitForTaskChange(taskId: string, _afterCursor: number, _afterRevision: number, waitMs: number): Promise<TaskChangeResult> {
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 5)));
    return { timedOut: true, connection: this.snapshot(), ledger: await this.ledger.snapshot(taskId) };
  }
  async answerQuestion(_taskId: string, requestId: string, answers: DshQuestionAnswer[]) {
    return { requestId, answers };
  }
  async resolveApproval(_taskId: string, requestId: string, outcome: "allow_once" | "reject") {
    return { requestId, outcome };
  }
}
