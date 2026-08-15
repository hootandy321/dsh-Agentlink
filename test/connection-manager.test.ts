import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { WebSocket } from "ws";

import type { BridgeConfig } from "../src/config.js";
import { DshConnectionManager, PendingInteractionError } from "../src/connection-manager.js";
import { BridgeCapabilityError, BridgeService } from "../src/bridge-service.js";
import { DshClient } from "../src/dsh-client.js";
import type { DshMuxFrame, DshServerRequest } from "../src/dsh-types.js";
import { EventLedger } from "../src/event-ledger.js";
import { TaskStore } from "../src/task-store.js";
import { FakeDshApi } from "./support/fakes.js";
import { startMockDshHost, type MockDshHost } from "./support/mock-dsh-host.js";

function config(host: MockDshHost, homeDir: string): BridgeConfig {
  return {
    hostUrl: host.baseUrl,
    homeDir,
    requestTimeoutMs: 1_000,
    allowRemoteHost: false,
  };
}

function client(host: MockDshHost): DshClient {
  return new DshClient(
    host.baseUrl,
    1_000,
    globalThis.fetch,
    (url) => new WebSocket(url) as unknown as globalThis.WebSocket,
  );
}

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function managerInternals(manager: DshConnectionManager) {
  return manager as unknown as {
    sessions: Map<string, { reconciling: boolean; subscribedLastSeq?: number }>;
    reconcileSession(sessionId: string, signal?: AbortSignal): Promise<void>;
    onEnvelope(envelope: DshServerRequest<DshMuxFrame>, signal: AbortSignal): Promise<void>;
  };
}

function muxEnvelope(frame: DshMuxFrame, rpcId: string): DshServerRequest<DshMuxFrame> {
  return { type: "server-request", rpcId, method: frame.type, payload: frame };
}

function installReadHandlers(host: MockDshHost, histories: Record<string, unknown[]>) {
  host.setUnaryHandler("host.describe", () => ({
    version: "0.0.1",
    cwd: "/tmp",
    attachedSessions: Object.keys(histories).length,
    canOpenPath: true,
  }));
  host.setUnaryHandler("session.list", () => ({
    items: [
      { sessionId: "root-session", updatedAt: 1, running: false, blank: false },
      ...(histories["child-session"] === undefined
        ? []
        : [
            {
              sessionId: "child-session",
              updatedAt: 1,
              running: false,
              blank: false,
              parentSessionId: "root-session",
              origin: "subagent",
            },
          ]),
    ],
  }));
  host.setUnaryHandler("session.history", (payload) => {
    const sessionId = (payload as { sessionId: string }).sessionId;
    return { events: histories[sessionId] ?? [], hasMore: false };
  });
  host.setUnaryHandler("subagent.list", () => ({
    parentAvailable: true,
    entries:
      histories["child-session"] === undefined
        ? []
        : [
            {
              kind: "child",
              id: "child-session",
              mode: "continuable",
              label: "worker",
              activity: "inactive",
              hasChildren: false,
            },
          ],
  }));
  host.setUnaryHandler("subagent.history", (payload) => {
    const sessionId = (payload as { childSessionId: string }).childSessionId;
    return { events: histories[sessionId] ?? [], hasMore: false };
  });
}

test("stop waits for detached reconciliation and prevents new reconciliation after stopping", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-manager-stop-"));
  const tasks = new TaskStore(home);
  const task = await tasks.create("root-session");
  const ledger = new EventLedger(home);
  const api = new FakeDshApi();
  const manager = new DshConnectionManager(
    { hostUrl: "http://127.0.0.1:3080", homeDir: home, requestTimeoutMs: 1_000, allowRemoteHost: false },
    api,
    tasks,
    ledger,
  );
  const internals = managerInternals(manager);
  const snapshotEntered = deferred();
  const releaseSnapshot = deferred();
  const originalSnapshot = ledger.snapshot.bind(ledger);
  let snapshotCalls = 0;
  ledger.snapshot = async (taskId) => {
    snapshotCalls += 1;
    if (snapshotCalls === 1) {
      snapshotEntered.resolve();
      await releaseSnapshot.promise;
    }
    return originalSnapshot(taskId);
  };

  let reconciliation: Promise<void> | undefined;
  try {
    await manager.trackTask(task);
    internals.sessions.get("root-session")!.subscribedLastSeq = -1;
    reconciliation = internals.reconcileSession("root-session");
    await snapshotEntered.promise;

    let stopResolved = false;
    const stopping = manager.stop().then(() => {
      stopResolved = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopResolved, false, "stop must wait for the detached reconciliation");

    releaseSnapshot.resolve();
    await stopping;
    await reconciliation;
    assert.equal(manager.snapshot().availability, "stopped");

    const callsAfterStop = snapshotCalls;
    await internals.reconcileSession("root-session");
    assert.equal(snapshotCalls, callsAfterStop, "no reconciliation may start after stop begins");
    await rm(home, { recursive: true, force: true });
  } finally {
    releaseSnapshot.resolve();
    await reconciliation?.catch(() => undefined);
    await manager.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test("buffer draining bumps revision only for durable frames", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-manager-buffer-"));
  const tasks = new TaskStore(home);
  const task = await tasks.create("root-session");
  const ledger = new EventLedger(home);
  const manager = new DshConnectionManager(
    { hostUrl: "http://127.0.0.1:3080", homeDir: home, requestTimeoutMs: 1_000, allowRemoteHost: false },
    new FakeDshApi(),
    tasks,
    ledger,
  );
  const internals = managerInternals(manager);
  const snapshotEntered = deferred();
  const releaseSnapshot = deferred();
  const originalSnapshot = ledger.snapshot.bind(ledger);
  const beforeLedger = await originalSnapshot(task.taskId);
  let blockSnapshot = true;
  ledger.snapshot = async (taskId) => {
    if (blockSnapshot) {
      blockSnapshot = false;
      snapshotEntered.resolve();
      await releaseSnapshot.promise;
    }
    return originalSnapshot(taskId);
  };

  try {
    await manager.trackTask(task);
    internals.sessions.get("root-session")!.subscribedLastSeq = -1;
    const revisionBefore = manager.snapshot().revision;
    const reconciliation = internals.reconcileSession("root-session");
    await snapshotEntered.promise;
    const signal = new AbortController().signal;

    await internals.onEnvelope(
      muxEnvelope({
        type: "session/event",
        sessionId: "root-session",
        event: { type: "assistant/chunk", seq: 0, time: 1, data: { text: "SECRET ephemeral chunk" } },
      }, "chunk-rpc"),
      signal,
    );
    await internals.onEnvelope(
      muxEnvelope({
        type: "session/projection",
        sessionId: "root-session",
        key: "SECRET projection key",
        value: { text: "SECRET projection value" },
        seq: 0,
      }, "projection-rpc"),
      signal,
    );
    await internals.onEnvelope(
      muxEnvelope({
        type: "session/jobs",
        sessionId: "root-session",
        jobs: [{ token: "SECRET jobs token" }],
      }, "jobs-rpc"),
      signal,
    );
    await internals.onEnvelope(
      muxEnvelope({
        type: "session/event",
        sessionId: "root-session",
        event: { type: "turn/start", seq: 1, time: 2, data: { turn: 1 } },
      }, "event-rpc"),
      signal,
    );
    assert.equal(manager.snapshot().revision, revisionBefore);

    releaseSnapshot.resolve();
    await reconciliation;
    const afterLedger = await originalSnapshot(task.taskId);
    assert.equal(afterLedger.cursor, beforeLedger.cursor + 2);
    assert.equal(manager.snapshot().revision, revisionBefore + 2);
    const raw = await readFile(afterLedger.logPath, "utf8");
    assert.equal(raw.includes("SECRET"), false);
    assert.equal(raw.includes("session/jobs"), true);
    assert.equal(raw.includes("turn/start"), true);
    assert.equal(raw.includes("session/projection"), false);
    assert.equal(raw.includes("assistant/chunk"), false);
  } finally {
    releaseSnapshot.resolve();
    await manager.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test("buffered queue snapshot bumps once for live view and not again when drained", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-manager-buffered-queue-"));
  const tasks = new TaskStore(home);
  const task = await tasks.create("root-session");
  const ledger = new EventLedger(home);
  const manager = new DshConnectionManager(
    { hostUrl: "http://127.0.0.1:3080", homeDir: home, requestTimeoutMs: 1_000, allowRemoteHost: false },
    new FakeDshApi(),
    tasks,
    ledger,
  );
  const internals = managerInternals(manager);
  const snapshotEntered = deferred();
  const releaseSnapshot = deferred();
  const originalSnapshot = ledger.snapshot.bind(ledger);
  const beforeLedger = await originalSnapshot(task.taskId);
  let blockSnapshot = true;
  ledger.snapshot = async (taskId) => {
    if (blockSnapshot) {
      blockSnapshot = false;
      snapshotEntered.resolve();
      await releaseSnapshot.promise;
    }
    return originalSnapshot(taskId);
  };

  try {
    await manager.trackTask(task);
    internals.sessions.get("root-session")!.subscribedLastSeq = -1;
    const revisionBefore = manager.snapshot().revision;
    const reconciliation = internals.reconcileSession("root-session");
    await snapshotEntered.promise;

    await internals.onEnvelope(
      muxEnvelope(
        {
          type: "session/queue",
          sessionId: "root-session",
          items: [{ id: "queued-1", placement: "queued", message: { role: "user", content: [{ type: "text", text: "buffered" }] } }],
        },
        "buffered-queue-rpc",
      ),
      new AbortController().signal,
    );
    assert.equal(manager.snapshot().revision, revisionBefore + 1);
    assert.deepEqual(manager.queueForSession("root-session").items[0], {
      id: "queued-1",
      placement: "queued",
      message: { role: "user", content: [{ type: "text", text: "buffered" }] },
    });

    releaseSnapshot.resolve();
    await reconciliation;
    const afterLedger = await originalSnapshot(task.taskId);
    assert.equal(afterLedger.cursor, beforeLedger.cursor + 1);
    assert.equal(manager.snapshot().revision, revisionBefore + 1);
  } finally {
    releaseSnapshot.resolve();
    await manager.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test("queue snapshots bump on durable or local live-view changes while jobs bump only on durable changes", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-manager-observable-"));
  try {
    const tasks = new TaskStore(home);
    const task = await tasks.create("root-session");
    const ledger = new EventLedger(home);
    const api = new FakeDshApi();
    const manager = new DshConnectionManager(
      { hostUrl: "http://127.0.0.1:3080", homeDir: home, requestTimeoutMs: 1_000, allowRemoteHost: false },
      api,
      tasks,
      ledger,
      { reconnectDelayMs: 10 },
    );
    await manager.trackTask(task);
    const runtime = managerInternals(manager).sessions.get("root-session");
    assert.ok(runtime !== undefined);
    runtime.reconciling = false;
    const signal = new AbortController().signal;

    let cursor = (await ledger.snapshot(task.taskId)).cursor;
    let revision = manager.snapshot().revision;
    await managerInternals(manager).onEnvelope(
      muxEnvelope(
        {
          type: "session/queue",
          sessionId: "root-session",
          items: [{ id: "queued-1", placement: "queued", message: { role: "user", content: [{ type: "text", text: "first" }] } }],
        },
        "queue-1",
      ),
      signal,
    );
    assert.equal((await ledger.snapshot(task.taskId)).cursor, cursor + 1);
    assert.equal(manager.snapshot().revision, revision + 1);
    assert.deepEqual(manager.queueForSession("root-session").items[0], {
      id: "queued-1",
      placement: "queued",
      message: { role: "user", content: [{ type: "text", text: "first" }] },
    });

    cursor = (await ledger.snapshot(task.taskId)).cursor;
    revision = manager.snapshot().revision;
    await managerInternals(manager).onEnvelope(
      muxEnvelope(
        {
          type: "session/queue",
          sessionId: "root-session",
          items: [{ id: "queued-1", placement: "queued", message: { role: "user", content: [{ type: "text", text: "first" }] } }],
        },
        "queue-2",
      ),
      signal,
    );
    assert.equal((await ledger.snapshot(task.taskId)).cursor, cursor);
    assert.equal(manager.snapshot().revision, revision);

    await managerInternals(manager).onEnvelope(
      muxEnvelope(
        {
          type: "session/queue",
          sessionId: "root-session",
          items: [{ id: "queued-1", placement: "queued", message: { role: "user", content: [{ type: "text", text: "edited" }] } }],
        },
        "queue-3",
      ),
      signal,
    );
    assert.equal((await ledger.snapshot(task.taskId)).cursor, cursor);
    assert.equal(manager.snapshot().revision, revision + 1);
    assert.deepEqual(manager.queueForSession("root-session").items[0], {
      id: "queued-1",
      placement: "queued",
      message: { role: "user", content: [{ type: "text", text: "edited" }] },
    });

    cursor = (await ledger.snapshot(task.taskId)).cursor;
    revision = manager.snapshot().revision;
    await managerInternals(manager).onEnvelope(
      muxEnvelope({ type: "session/jobs", sessionId: "root-session", jobs: [{ id: "job-1", status: "running", message: "SECRET job body" }] }, "jobs-1"),
      signal,
    );
    assert.equal((await ledger.snapshot(task.taskId)).cursor, cursor + 1);
    assert.equal(manager.snapshot().revision, revision + 1);

    cursor = (await ledger.snapshot(task.taskId)).cursor;
    revision = manager.snapshot().revision;
    await managerInternals(manager).onEnvelope(
      muxEnvelope({ type: "session/jobs", sessionId: "root-session", jobs: [{ id: "job-1", status: "running", message: "SECRET changed but structurally same" }] }, "jobs-2"),
      signal,
    );
    assert.equal((await ledger.snapshot(task.taskId)).cursor, cursor);
    assert.equal(manager.snapshot().revision, revision);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("connection manager subscribes before history recovery, merges live frames, and tracks descendants", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-manager-"));
  const host = await startMockDshHost();
  const histories = {
    "root-session": [
      { event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } } },
      {
        event: {
          type: "assistant/message",
          seq: 1,
          time: 2,
          data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "root final" }] } },
        },
      },
    ],
    "child-session": [
      { event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } } },
      { event: { type: "turn/end", seq: 1, time: 2, data: { turn: 1, reason: { kind: "completed" } } } },
    ],
  };
  installReadHandlers(host, histories);
  host.setMuxBaseline([
    { type: "session/subscribed", sessionId: "root-session", lastSeq: 1 },
    { type: "session/subscribed", sessionId: "child-session", lastSeq: 1 },
    {
      type: "session/event",
      sessionId: "root-session",
      event: { type: "turn/end", seq: 2, time: 3, data: { turn: 1, reason: { kind: "completed" } } },
    },
    {
      type: "session/queue",
      sessionId: "root-session",
      items: [
        {
          id: "queued-1",
          placement: "queued",
          message: { role: "user", content: [{ type: "text", text: "later" }], source: { kind: "user" } },
        },
      ],
    },
  ]);

  const tasks = new TaskStore(home);
  const task = await tasks.create("root-session");
  const ledger = new EventLedger(home);
  const manager = new DshConnectionManager(config(host, home), client(host), tasks, ledger, {
    reconnectDelayMs: 100,
  });
  manager.start();
  try {
    await eventually(async () => {
      const watermarks = (await ledger.snapshot(task.taskId)).watermarks;
      return watermarks["root-session"] === 2 && watermarks["child-session"] === 1;
    });
    const snapshot = await ledger.snapshot(task.taskId);
    assert.deepEqual(snapshot.finalMessagePointer, { sessionId: "root-session", seq: 1 });
    assert.equal(snapshot.execution, "turn_completed");
    assert.deepEqual(snapshot.watermarks, { "root-session": 2, "child-session": 1 });
    assert.equal(manager.lineageForTask(task.taskId).length, 2);
    assert.equal(manager.lineageForTask(task.taskId)[1]?.historyCapability, "subagent.history");
    assert.equal(manager.queueForSession("root-session").items[0]?.id, "queued-1");
    assert.ok(host.timeline.indexOf("mux:open") < host.timeline.indexOf("http:session.history"));
    assert.equal(manager.snapshot().capabilities.muxResumeSince, false);
    assert.equal(manager.snapshot().compatibility, "untested");
    assert.match(manager.snapshot().warning ?? "", /CLI\/package version is unknown/);

    const beforeLineageChange = manager.snapshot().revision;
    host.setUnaryHandler("session.list", () => ({
      items: [
        { sessionId: "root-session", updatedAt: 2, running: true, blank: false },
        {
          sessionId: "child-session",
          updatedAt: 2,
          running: false,
          blank: false,
          parentSessionId: "root-session",
          origin: "subagent",
        },
      ],
    }));
    await manager.refreshLineage();
    assert.ok(manager.snapshot().revision > beforeLineageChange);
    assert.equal(manager.lineageForTask(task.taskId)[0]?.running, true);
  } finally {
    await manager.stop();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("pending question responses are typed, non-retried, and tombstoned against replay", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-manager-"));
  const host = await startMockDshHost();
  installReadHandlers(host, { "root-session": [] });
  host.setMuxBaseline([{ type: "session/subscribed", sessionId: "root-session", lastSeq: -1 }]);
  const tasks = new TaskStore(home);
  const task = await tasks.create("root-session");
  const ledger = new EventLedger(home);
  const manager = new DshConnectionManager(config(host, home), client(host), tasks, ledger, { reconnectDelayMs: 100 });
  manager.start();
  try {
    await eventually(() => manager.snapshot().availability === "connected");
    const requested = {
      type: "question/requested",
      sessionId: "root-session",
      questions: [{ id: "q1", question: "Pick", options: [{ label: "yes" }], multiSelect: false }],
    };
    host.sendMux(requested, { rpcId: "question-rpc" });
    await eventually(() => manager.pendingForTask(task.taskId).length === 1);

    const receipt = await manager.answerQuestion(task.taskId, "question-rpc", [{ id: "q1", selected: ["yes"] }]);
    assert.deepEqual(receipt, {
      requestId: "question-rpc",
      sessionId: "root-session",
      accepted: true,
      interaction: "question",
    });
    assert.equal(host.responses.length, 1);
    assert.deepEqual(host.responses[0]?.body, {
      type: "client-response",
      rpcId: "question-rpc",
      result: {
        ok: true,
        value: { sessionId: "root-session", answer: { answers: [{ id: "q1", selected: ["yes"] }] } },
      },
    });
    assert.equal(manager.pendingForTask(task.taskId).length, 0);

    host.sendMux(requested, { rpcId: "question-rpc" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(manager.pendingForTask(task.taskId).length, 0);
    await assert.rejects(
      () => manager.answerQuestion(task.taskId, "question-rpc", [{ id: "q1", selected: ["yes"] }]),
      (error: unknown) => error instanceof PendingInteractionError && error.code === "not-pending",
    );
    assert.equal(host.responses.length, 1);
  } finally {
    await manager.stop();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("mux disconnect changes availability without changing last execution state", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-manager-"));
  const host = await startMockDshHost();
  installReadHandlers(host, {
    "root-session": [
      { event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } } },
      {
        event: {
          type: "assistant/message",
          seq: 1,
          time: 2,
          data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "done" }] } },
        },
      },
      { event: { type: "turn/end", seq: 2, time: 3, data: { turn: 1, reason: { kind: "completed" } } } },
    ],
  });
  host.setMuxBaseline([{ type: "session/subscribed", sessionId: "root-session", lastSeq: 2 }]);
  const tasks = new TaskStore(home);
  const task = await tasks.create("root-session");
  const ledger = new EventLedger(home);
  const manager = new DshConnectionManager(config(host, home), client(host), tasks, ledger, { reconnectDelayMs: 500 });
  manager.start();
  try {
    await eventually(async () => (await ledger.snapshot(task.taskId)).execution === "turn_completed");
    host.closeMux(1011, "test disconnect");
    await eventually(() => manager.snapshot().availability === "host_unreachable");
    assert.equal((await ledger.snapshot(task.taskId)).lastKnownExecutionStatus, "turn_completed");
    assert.equal(manager.queueForSession("root-session").stale, true);
  } finally {
    await manager.stop();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("queue cancellation is unavailable until the current mux epoch supplies a queue snapshot", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-manager-"));
  const host = await startMockDshHost();
  installReadHandlers(host, { "root-session": [] });
  host.setMuxBaseline([{ type: "session/subscribed", sessionId: "root-session", lastSeq: -1 }]);
  const tasks = new TaskStore(home);
  const task = await tasks.create("root-session");
  const ledger = new EventLedger(home);
  const bridgeConfig = config(host, home);
  const api = client(host);
  const manager = new DshConnectionManager(bridgeConfig, api, tasks, ledger, { reconnectDelayMs: 100 });
  const service = new BridgeService(bridgeConfig, api, tasks, manager, ledger);
  manager.start();
  try {
    await eventually(() => manager.snapshot().availability === "connected");
    const queue = manager.queueForSession("root-session");
    assert.equal(queue.known, false);
    assert.equal(queue.stale, false);
    await assert.rejects(
      () => service.cancel(task.taskId, "queue"),
      (error: unknown) => error instanceof BridgeCapabilityError && error.code === "queue_snapshot_unavailable",
    );
    assert.equal(host.requests.some((request) => request.method === "session.updateQueue"), false);
  } finally {
    await manager.stop();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("reconnect withdraws interactions absent from the replay baseline and can reopen a delayed replay", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-manager-"));
  const host = await startMockDshHost();
  installReadHandlers(host, { "root-session": [] });
  host.setMuxBaseline([{ type: "session/subscribed", sessionId: "root-session", lastSeq: -1 }]);
  const tasks = new TaskStore(home);
  const task = await tasks.create("root-session");
  const ledger = new EventLedger(home);
  await ledger.append(task.taskId, {
    sourceSessionId: "root-session",
    origin: "root",
    type: "question/requested",
    raw: {
      type: "server-request",
      rpcId: "replayed-question",
      method: "question/requested",
      payload: {
        type: "question/requested",
        sessionId: "root-session",
        questions: [{ id: "q", question: "not persisted" }],
      },
    },
  });
  const manager = new DshConnectionManager(config(host, home), client(host), tasks, ledger, {
    reconnectDelayMs: 100,
    baselineQuietMs: 20,
  });
  manager.start();
  try {
    await eventually(async () => (await ledger.snapshot(task.taskId)).pendingInteractions.length === 0);
    assert.equal((await ledger.tail(task.taskId, 0, 20)).records.some((record) => record.type === "interaction/withdrawn"), true);

    host.sendMux(
      {
        type: "question/requested",
        sessionId: "root-session",
        questions: [{ id: "q", question: "late baseline replay" }],
      },
      { rpcId: "replayed-question" },
    );
    await eventually(() => manager.pendingForTask(task.taskId).length === 1);
    await eventually(async () => (await ledger.snapshot(task.taskId)).pendingInteractions.length === 1);
    assert.equal((await ledger.tail(task.taskId, 0, 20)).records.some((record) => record.type === "interaction/replayed"), true);
  } finally {
    await manager.stop();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("connected empty Host returns a clean session_not_found status for an existing task mapping", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-manager-"));
  const host = await startMockDshHost();
  installReadHandlers(host, {});
  host.setMuxBaseline([]);
  const tasks = new TaskStore(home);
  const task = await tasks.create("missing-root");
  const ledger = new EventLedger(home);
  const bridgeConfig = config(host, home);
  const api = client(host);
  const manager = new DshConnectionManager(bridgeConfig, api, tasks, ledger, {
    reconnectDelayMs: 100,
    baselineQuietMs: 20,
  });
  const service = new BridgeService(bridgeConfig, api, tasks, manager, ledger);
  manager.start();
  try {
    await eventually(() => manager.snapshot().availability === "connected");
    const status = await service.status(task.taskId);
    assert.equal(status.availability, "session_not_found");
    assert.equal(status.status, "unknown");
    assert.deepEqual(status.pendingInteractions, []);
    assert.equal(status.queueDepth.known, false);
    assert.equal(status.queueDepth.total, 0);
    assert.equal(status.running, null);
  } finally {
    await manager.stop();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("thousands of top-level projections are dropped while one following jobs frame is durable and scrubbed", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-manager-"));
  const host = await startMockDshHost();
  installReadHandlers(host, { "root-session": [] });
  host.setMuxBaseline([{ type: "session/subscribed", sessionId: "root-session", lastSeq: -1 }]);
  const tasks = new TaskStore(home);
  const task = await tasks.create("root-session");
  const ledger = new EventLedger(home);
  const manager = new DshConnectionManager(config(host, home), client(host), tasks, ledger, {
    reconnectDelayMs: 100,
    baselineQuietMs: 20,
  });
  manager.start();

  try {
    await eventually(() => manager.snapshot().availability === "connected");
    await eventually(() => manager.snapshot().capabilities.historyReconciliation === true);
    const before = await ledger.snapshot(task.taskId);
    const revisionBefore = manager.snapshot().revision;
    const projectionCount = 3_000;

    for (let index = 0; index < projectionCount; index++) {
      host.sendMux({
        type: "session/projection",
        sessionId: "root-session",
        key: `SECRET-projection-key-${index}`,
        value: { body: `SECRET-projection-value-${index}` },
        seq: index,
      });
    }
    host.sendMux({
      type: "session/jobs",
      sessionId: "root-session",
      jobs: [{ id: "job-1", token: "SECRET-job-token", prompt: "SECRET-job-body" }],
    });

    await eventually(async () => (await ledger.snapshot(task.taskId)).cursor === before.cursor + 1);
    const afterJobs = await ledger.snapshot(task.taskId);
    assert.equal(afterJobs.cursor, before.cursor + 1);
    assert.equal(manager.snapshot().revision, revisionBefore + 1);
    assert.deepEqual(afterJobs.watermarks, before.watermarks);

    const rawAfterJobs = await readFile(afterJobs.logPath, "utf8");
    const recordsAfterJobs = rawAfterJobs.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(recordsAfterJobs.length, 1);
    assert.equal(recordsAfterJobs[0].type, "session/jobs");
    assert.equal(recordsAfterJobs[0].coordination.type, "session/jobs");
    assert.equal(recordsAfterJobs[0].coordination.sessionId, "root-session");
    assert.equal(typeof recordsAfterJobs[0].coordination.rpcId, "string");
    assert.equal(recordsAfterJobs[0].coordination.jobs, undefined);
    assert.equal(rawAfterJobs.includes("SECRET"), false);
    assert.equal(rawAfterJobs.includes("projection-key"), false);
    assert.equal(rawAfterJobs.includes("projection-value"), false);
    assert.equal(rawAfterJobs.includes("job-token"), false);
    assert.equal(rawAfterJobs.includes("job-body"), false);

    host.sendMux({
      type: "session/event",
      sessionId: "root-session",
      event: { type: "turn/start", seq: 0, time: 100, data: { turn: 1 } },
    });
    host.sendMux({
      type: "session/event",
      sessionId: "root-session",
      event: {
        type: "assistant/message",
        seq: 1,
        time: 101,
        data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "SECRET final body" }] } },
      },
    });
    host.sendMux({
      type: "session/event",
      sessionId: "root-session",
      event: { type: "turn/end", seq: 2, time: 102, data: { turn: 1, reason: { kind: "completed" } } },
    });
    await eventually(async () => (await ledger.snapshot(task.taskId)).execution === "turn_completed");

    const beforeReconnect = await ledger.snapshot(task.taskId);
    assert.deepEqual(beforeReconnect.finalMessagePointer, { sessionId: "root-session", seq: 1 });
    installReadHandlers(host, {
      "root-session": [
        { event: { type: "turn/start", seq: 0, time: 100, data: { turn: 1 } } },
        {
          event: {
            type: "assistant/message",
            seq: 1,
            time: 101,
            data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "SECRET final body" }] } },
          },
        },
        { event: { type: "turn/end", seq: 2, time: 102, data: { turn: 1, reason: { kind: "completed" } } } },
      ],
    });
    host.setMuxBaseline([{ type: "session/subscribed", sessionId: "root-session", lastSeq: 2 }]);
    host.closeMux(1011, "trigger reconnect");
    await eventually(() => manager.snapshot().availability === "host_unreachable");
    await eventually(() => manager.snapshot().availability === "connected");
    await eventually(async () => (await ledger.snapshot(task.taskId)).execution === "turn_completed");

    const afterReconnect = await ledger.snapshot(task.taskId);
    assert.equal(afterReconnect.cursor, beforeReconnect.cursor);
    assert.deepEqual(afterReconnect.finalMessagePointer, { sessionId: "root-session", seq: 1 });
    assert.equal(afterReconnect.watermarks["root-session"], 2);
    const rawAfterReconnect = await readFile(afterReconnect.logPath, "utf8");
    assert.equal(rawAfterReconnect.includes("SECRET"), false);
  } finally {
    await manager.stop();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("high-frequency assistant content-stream progress is dropped from the persistent ledger without busy-polling", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-manager-"));
  const host = await startMockDshHost();
  const HISTORY_CHUNKS = 3_000;
  const LIVE_CHUNKS = 2_000;
  const STREAM_TYPES = ["assistant/message/delta", "assistant/delta", "assistant/chunk"] as const;

  const em = (seq: number, type: string, data: unknown) => ({ event: { type, seq, time: 10 + seq, data } });
  const history: { event: { type: string; seq: number; time: number; data: unknown } }[] = [
    em(0, "turn/start", { turn: 1 }),
    em(1, "user/message", { content: [{ type: "text", text: "hi" }] }),
    em(2, "assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "first final" }] } }),
  ];
  for (let i = 0; i < HISTORY_CHUNKS; i++) {
    history.push(em(3 + i, STREAM_TYPES[i % STREAM_TYPES.length], { message: { content: [{ type: "text", text: "frag" + i }] } }));
  }
  history.push(em(3 + HISTORY_CHUNKS, "assistant/message", { turn: 1, step: 2, message: { content: [{ type: "text", text: "second final" }] } }));
  history.push(em(4 + HISTORY_CHUNKS, "turn/end", { turn: 1, reason: { kind: "completed" } }));

  installReadHandlers(host, { "root-session": history });
  host.setMuxBaseline([{ type: "session/subscribed", sessionId: "root-session", lastSeq: 4 + HISTORY_CHUNKS }]);
  const tasks = new TaskStore(home);
  const task = await tasks.create("root-session");
  const ledger = new EventLedger(home);
  const manager = new DshConnectionManager(config(host, home), client(host), tasks, ledger, { reconnectDelayMs: 100 });
  manager.start();
  try {
    await eventually(async () => (await ledger.snapshot(task.taskId)).execution === "turn_completed");
    const afterReconcile = await ledger.snapshot(task.taskId);
    assert.deepEqual(afterReconcile.finalMessagePointer, { sessionId: "root-session", seq: 3 + HISTORY_CHUNKS });
    assert.equal(afterReconcile.watermarks["root-session"], 4 + HISTORY_CHUNKS);
    assert.equal(afterReconcile.cursor, 5);
    const reconcileText = await readFile(afterReconcile.logPath, "utf8");
    assert.equal(reconcileText.trim().split("\n").filter(Boolean).length, 5);
    assert.equal(reconcileText.includes("frag"), false);

    const turnStartSeq = 5 + HISTORY_CHUNKS;
    const userEventSeq = turnStartSeq + 1;
    const liveSeqBase = userEventSeq + 1;
    const beforeTurn2 = await ledger.snapshot(task.taskId);
    const revisionBeforeTurn2 = manager.snapshot().revision;
    host.sendMux({ type: "session/event", sessionId: "root-session", event: { type: "turn/start", seq: turnStartSeq, time: 60, data: { turn: 2 } } });
    host.sendMux({ type: "session/event", sessionId: "root-session", event: { type: "user/message", seq: userEventSeq, time: 61, data: { content: [{ type: "text", text: "again" }] } } });
    for (let i = 0; i < LIVE_CHUNKS; i++) {
      host.sendMux({ type: "session/event", sessionId: "root-session", event: { type: STREAM_TYPES[i % STREAM_TYPES.length], seq: liveSeqBase + i, time: 62 + i, data: { message: { content: [{ type: "text", text: "live" + i }] } } } });
    }
    host.sendMux({ type: "session/queue", sessionId: "root-session", items: [] });
    await eventually(async () => (await ledger.snapshot(task.taskId)).cursor === beforeTurn2.cursor + 3);

    const afterLive = await ledger.snapshot(task.taskId);
    assert.equal(afterLive.cursor, beforeTurn2.cursor + 3);
    assert.equal(manager.snapshot().revision, revisionBeforeTurn2 + 3);
    assert.equal(afterLive.watermarks["root-session"], userEventSeq);
    const liveText = await readFile(afterLive.logPath, "utf8");
    assert.equal(liveText.includes("live"), false);

    const finalSeq = liveSeqBase + LIVE_CHUNKS;
    const turn2EndSeq = finalSeq + 1;
    const turn2History: { event: { type: string; seq: number; time: number; data: unknown } }[] = [
      em(turnStartSeq, "turn/start", { turn: 2 }),
      em(userEventSeq, "user/message", { content: [{ type: "text", text: "again" }] }),
    ];
    for (let i = 0; i < LIVE_CHUNKS; i++) {
      turn2History.push(em(liveSeqBase + i, STREAM_TYPES[i % STREAM_TYPES.length], { message: { content: [{ type: "text", text: "refrag" + i }] } }));
    }
    turn2History.push(em(finalSeq, "assistant/message", { turn: 2, step: 1, message: { content: [{ type: "text", text: "live final" }] } }));
    turn2History.push(em(turn2EndSeq, "turn/end", { turn: 2, reason: { kind: "completed" } }));
    installReadHandlers(host, { "root-session": [...history, ...turn2History] });
    host.setMuxBaseline([{ type: "session/subscribed", sessionId: "root-session", lastSeq: turn2EndSeq }]);

    host.closeMux(1011, "trigger reconnect");
    await eventually(() => manager.snapshot().availability === "host_unreachable");
    await eventually(() => manager.snapshot().availability === "connected");
    await eventually(async () => (await ledger.snapshot(task.taskId)).execution === "turn_completed");
    const afterReconnect = await ledger.snapshot(task.taskId);
    assert.equal(afterReconnect.cursor, afterLive.cursor + 2);
    assert.deepEqual(afterReconnect.finalMessagePointer, { sessionId: "root-session", seq: finalSeq });
    assert.equal(afterReconnect.watermarks["root-session"], turn2EndSeq);
    const reconnectText = await readFile(afterReconnect.logPath, "utf8");
    assert.equal(reconnectText.trim().split("\n").filter(Boolean).length, afterReconnect.cursor);
    assert.equal(reconnectText.includes("refrag"), false);
    assert.equal(reconnectText.includes("live"), false);
  } finally {
    await manager.stop();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});
