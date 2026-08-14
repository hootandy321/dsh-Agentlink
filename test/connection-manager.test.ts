import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { WebSocket } from "ws";

import type { BridgeConfig } from "../src/config.js";
import { DshConnectionManager, PendingInteractionError } from "../src/connection-manager.js";
import { BridgeCapabilityError, BridgeService } from "../src/bridge-service.js";
import { DshClient } from "../src/dsh-client.js";
import { EventLedger } from "../src/event-ledger.js";
import { TaskStore } from "../src/task-store.js";
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
