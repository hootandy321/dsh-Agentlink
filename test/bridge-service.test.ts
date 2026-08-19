import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BridgeCapabilityError, BridgeService, DelegationSetupError, StaleViewError } from "../src/bridge-service.js";
import type { BridgeConfig } from "../src/config.js";
import { DshRpcError } from "../src/dsh-client.js";
import { EventLedger } from "../src/event-ledger.js";
import { TaskStore } from "../src/task-store.js";
import { WorkspaceClaimStore } from "../src/workspace-claim.js";
import { FakeConnection, FakeDshApi } from "./support/fakes.js";

function config(homeDir: string): BridgeConfig {
  return {
    hostUrl: "http://127.0.0.1:3080",
    homeDir,
    requestTimeoutMs: 1_000,
    allowRemoteHost: false,
  };
}

test("delegate validates cwd, never passes model, stays detached, and followup preserves the root session", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    const tasks = new TaskStore(home);
    const ledger = new EventLedger(home);
    const connection = new FakeConnection(ledger);
    const service = new BridgeService(config(home), api, tasks, connection, ledger);

    const delegated = await service.delegate({ prompt: "Implement this", cwd: home });
    assert.equal(delegated.accepted, true);
    assert.equal(delegated.detached, true);
    assert.equal(delegated.rootSessionId, "root-session");
    assert.deepEqual(delegated.workspaceClaimSemantics, {
      enforcement: "bridge-cooperative-only",
      controlsDshSandbox: false,
      description:
        "workspaceMode is a bridge-local coordination claim shared only by bridge processes using the same bridge home; it does not select, enforce, or verify the DSH Host filesystem sandbox.",
    });
    const create = api.calls.find((call) => call.method === "session.create");
    const prompt = api.calls.find((call) => call.method === "session.prompt");
    assert.deepEqual(create?.payload, { cwd: await realpath(home) });
    assert.equal("model" in (create?.payload as Record<string, unknown>), false);
    assert.equal("model" in (prompt?.payload as Record<string, unknown>), false);

    await service.continueTask(delegated.taskId, "later", "queue");
    await service.continueTask(delegated.taskId, "now", "steer");
    const followups = api.calls.filter((call) => call.method === "session.prompt").slice(1);
    assert.deepEqual(followups.map((call) => (call.payload as { mode: string }).mode), ["queue", "steer"]);
    assert.deepEqual(followups.map((call) => (call.payload as { sessionId: string }).sessionId), ["root-session", "root-session"]);

    const released = await service.releaseWorkspace(delegated.taskId);
    assert.equal(released.sessionClosedByRelease, false);
    assert.equal(released.sessionExistence, "not_checked");
    await assert.rejects(
      () => service.continueTask(delegated.taskId, "after release", "queue"),
      (error: unknown) => error instanceof BridgeCapabilityError && error.code === "workspace_claim_missing",
    );

    const beforeInvalid = api.calls.length;
    await assert.rejects(() => service.delegate({ prompt: "bad", cwd: join(home, "missing") }), /cwd does not exist/);
    assert.equal(api.calls.length, beforeInvalid);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("delegate read-only is only a bridge claim and does not mutate DSH permissions", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    const tasks = new TaskStore(home);
    const ledger = new EventLedger(home);
    const connection = new FakeConnection(ledger);
    const service = new BridgeService(config(home), api, tasks, connection, ledger);

    const delegated = await service.delegate({ prompt: "Inspect this", cwd: home, workspaceMode: "read-only" });
    const create = api.calls.find((call) => call.method === "session.create");
    const claim = await new WorkspaceClaimStore(home).get(delegated.taskId);

    assert.deepEqual(create?.payload, { cwd: await realpath(home) });
    assert.equal(api.calls.some((call) => /permission|sandbox/i.test(call.method)), false);
    assert.equal(claim?.mode, "read-only");
    assert.equal(delegated.workspaceClaimSemantics.controlsDshSandbox, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("delegate retains the task mapping when route verification fails and does not prompt", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.models = { ...api.models, routable: false };
    const tasks = new TaskStore(home);
    const ledger = new EventLedger(home);
    const service = new BridgeService(config(home), api, tasks, new FakeConnection(ledger), ledger);

    await assert.rejects(
      () => service.delegate({ prompt: "work", cwd: home }),
      (error: unknown) => error instanceof DelegationSetupError && error.stage === "models" && error.taskId !== undefined,
    );
    assert.equal((await tasks.list()).length, 1);
    assert.equal(api.calls.some((call) => call.method === "session.prompt"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status separates availability from execution and reports terminal_missing_final", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.sessions = [{ sessionId: "root-session", updatedAt: 1, running: false, blank: false }];
    const tasks = new TaskStore(home);
    const task = await tasks.create("root-session");
    const ledger = new EventLedger(home);
    await ledger.append(task.taskId, {
      sourceSessionId: "root-session",
      sourceSeq: 0,
      origin: "root",
      type: "session/event",
      raw: { type: "session/event", sessionId: "root-session", event: { type: "turn/start", seq: 0, time: 1, data: { turn: 4 } } },
    });
    await ledger.append(task.taskId, {
      sourceSessionId: "root-session",
      sourceSeq: 1,
      origin: "root",
      type: "session/event",
      raw: {
        type: "session/event",
        sessionId: "root-session",
        event: { type: "turn/end", seq: 1, time: 2, data: { turn: 4, reason: { kind: "aborted", reason: { kind: "user" } } } },
      },
    });
    const connection = new FakeConnection(ledger);
    connection.lineage = [
      { sessionId: "root-session", found: true, origin: "root", running: false, blank: false, historyCapability: "session.history" },
    ];
    const service = new BridgeService(config(home), api, tasks, connection, ledger);

    const connected = await service.status(task.taskId);
    assert.equal(connected.availability, "connected");
    assert.equal(connected.workspaceClaimSemantics.controlsDshSandbox, false);
    assert.equal(connected.execution, "canceled");
    assert.equal(connected.status, "canceled");
    assert.equal(connected.finalMessage, null);
    assert.equal(connected.finalMessageStatus, "terminal_missing_final");
    assert.equal(connected.turn, null);

    connection.state = { ...connection.state, availability: "host_unreachable", revision: 2 };
    const unavailable = await service.status(task.taskId);
    assert.equal(unavailable.availability, "host_unreachable");
    assert.equal(unavailable.status, "unknown");
    assert.equal(unavailable.lastKnownExecutionStatus, "canceled");

    connection.state = { ...connection.state, availability: "connected", revision: 3 };
    connection.pending = [
      {
        type: "server-request",
        rpcId: "stale-question",
        method: "question/requested",
        payload: {
          type: "question/requested",
          sessionId: "root-session",
          questions: [{ id: "q", question: "stale" }],
        },
      },
    ];
    connection.queue = {
      known: true,
      stale: false,
      connectionEpoch: 1,
      items: [{ id: "stale-item", placement: "queued", message: { role: "user", content: [] } }],
    };
    connection.lineage = [
      { sessionId: "root-session", found: false, origin: "root", historyCapability: "session.history" },
    ];
    const missing = await service.status(task.taskId);
    assert.equal(missing.availability, "session_not_found");
    assert.equal(missing.status, "unknown");
    assert.deepEqual(missing.pendingInteractions, []);
    assert.deepEqual(missing.queueDepth, {
      known: false,
      stale: false,
      nextTurn: 0,
      nextStep: 0,
      steering: 0,
      context: 0,
      total: 0,
    });
    assert.equal(missing.running, null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status does not report a vanished active turn as still running after Host recovery", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.sessions = [{ sessionId: "root-session", updatedAt: 2, running: false, blank: false }];
    const tasks = new TaskStore(home);
    const task = await tasks.create("root-session");
    const ledger = new EventLedger(home);
    await ledger.append(task.taskId, {
      sourceSessionId: "root-session",
      sourceSeq: 0,
      origin: "root",
      type: "session/event",
      raw: {
        type: "session/event",
        sessionId: "root-session",
        event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      },
    });
    const connection = new FakeConnection(ledger);
    connection.lineage = [
      {
        sessionId: "root-session",
        found: true,
        origin: "root",
        running: false,
        blank: false,
        historyCapability: "session.history",
      },
    ];
    const service = new BridgeService(config(home), api, tasks, connection, ledger);

    const status = await service.status(task.taskId);
    assert.equal(status.availability, "connected");
    assert.equal(status.execution, "interrupted");
    assert.equal(status.lastKnownExecutionStatus, "interrupted");
    assert.equal(status.finalMessageStatus, "terminal_missing_final");
    assert.equal((await ledger.snapshot(task.taskId)).lastKnownExecutionStatus, "interrupted");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("cancel turn preserves queue while cancel queue performs non-atomic per-item removals", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    const tasks = new TaskStore(home);
    const task = await tasks.create("root-session");
    const ledger = new EventLedger(home);
    const connection = new FakeConnection(ledger);
    connection.lineage = [
      { sessionId: "root-session", found: true, origin: "root", running: true, blank: false, historyCapability: "session.history" },
    ];
    connection.queue = {
      known: true,
      stale: false,
      connectionEpoch: 1,
      items: [
        { id: "one", placement: "queued", message: { role: "user", content: [] } },
        { id: "two", placement: "steering", message: { role: "user", content: [] } },
        { id: "three", placement: "context", message: { role: "user", content: [] } },
      ],
    };
    api.updateQueueErrors.set("two", new DshRpcError("queue-item-not-found", "claimed", { itemId: "two" }));
    api.updateQueueErrors.set("three", new Error("transport ambiguous"));
    const service = new BridgeService(config(home), api, tasks, connection, ledger);

    const turn = await service.cancel(task.taskId, "turn");
    assert.equal(turn.scope, "turn");
    assert.equal(turn.queuedMessagesPreserved, true);
    assert.equal(turn.runInBackgroundJobsPreserved, true);

    const queue = await service.cancel(task.taskId, "queue");
    assert.equal(queue.nonAtomic, true);
    assert.deepEqual(queue.requested, ["one", "two", "three"]);
    assert.deepEqual(queue.removed, ["one"]);
    assert.deepEqual(queue.alreadyClaimed, ["two"]);
    assert.equal(queue.failed.length, 1);
    assert.equal(api.calls.filter((call) => call.method === "session.updateQueue").length, 3);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("wait is bounded and tail returns task cursors plus current pending snapshot", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.sessions = [{ sessionId: "root-session", updatedAt: 1, running: false, blank: true }];
    const tasks = new TaskStore(home);
    const task = await tasks.create("root-session");
    const ledger = new EventLedger(home);
    const connection = new FakeConnection(ledger);
    connection.lineage = [
      { sessionId: "root-session", found: true, origin: "root", running: false, blank: true, historyCapability: "session.history" },
    ];
    const service = new BridgeService(config(home), api, tasks, connection, ledger);

    const waited = await service.wait(task.taskId, 1, 0);
    assert.equal(waited.timedOut, true);
    assert.equal(waited.status.execution, "starting");
    assert.equal(waited.nextCursor, 0);
    await assert.rejects(() => service.wait(task.taskId, 31), /between 0 and 30/);

    const tailed = await service.tail(task.taskId, 0, 10, 10_000);
    assert.deepEqual(tailed.events, []);
    assert.equal(tailed.nextCursor, 0);
    assert.equal(tailed.delivery.startsWith("at-least-once"), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("followup refreshes route state and rejects stale cursor or revision views before writing", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    const tasks = new TaskStore(home);
    const task = await tasks.create("root-session");
    await new WorkspaceClaimStore(home).acquire({
      canonicalCwd: home,
      taskId: task.taskId,
      sessionId: task.sessionId,
      mode: "exclusive-write",
    });
    const ledger = new EventLedger(home);
    await ledger.append(task.taskId, {
      sourceSessionId: "root-session",
      sourceSeq: 0,
      origin: "root",
      type: "session/event",
      raw: {
        type: "session/event",
        sessionId: "root-session",
        event: {
          type: "user/message",
          seq: 0,
          time: 1,
          data: { content: [{ type: "text", text: "external web change" }], source: { kind: "user" } },
        },
      },
    });
    const connection = new FakeConnection(ledger);
    connection.lineage = [
      { sessionId: "root-session", found: true, origin: "root", running: true, blank: false, historyCapability: "session.history" },
    ];
    const service = new BridgeService(config(home), api, tasks, connection, ledger);

    await assert.rejects(
      () => service.continueTask(task.taskId, "write", "queue", { sinceCursor: 0 }),
      (error: unknown) =>
        error instanceof StaleViewError &&
        error.code === "stale_view" &&
        error.details.currentCursor === 1,
    );
    await assert.rejects(
      () => service.continueTask(task.taskId, "write", "queue", { expectedRevision: 0 }),
      (error: unknown) => error instanceof StaleViewError,
    );
    assert.equal(api.calls.some((call) => call.method === "session.prompt"), false);

    const result = await service.continueTask(task.taskId, "write", "queue", {
      sinceCursor: 1,
      expectedRevision: 1,
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.model, api.models.current);
    assert.equal(typeof result.issuedRpcId, "string");
    assert.equal((await ledger.tail(task.taskId, 0, 10)).records.some((record) => record.type === "bridge/prompt-issued"), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status and tail hydrate conversation content from live DSH history without persisting it", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.sessions = [{ sessionId: "root-session", updatedAt: 1, running: false, blank: false }];
    const tasks = new TaskStore(home);
    const task = await tasks.create("root-session");
    const ledger = new EventLedger(home);
    const entries = [
      { event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } } },
      {
        event: {
          type: "assistant/message",
          seq: 1,
          time: 2,
          data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "live final only" }] } },
        },
      },
      { event: { type: "turn/end", seq: 2, time: 3, data: { turn: 1, reason: { kind: "completed" } } } },
    ];
    for (const entry of entries) {
      await ledger.append(task.taskId, {
        sourceSessionId: "root-session",
        sourceSeq: entry.event.seq,
        origin: "root",
        type: "session/event",
        raw: { type: "session/event", sessionId: "root-session", event: entry.event },
      });
    }
    const connection = new FakeConnection(ledger);
    connection.lineage = [
      { sessionId: "root-session", found: true, origin: "root", running: false, blank: false, historyCapability: "session.history" },
    ];
    connection.histories.set("root-session", { events: entries, hasMore: false });
    const service = new BridgeService(config(home), api, tasks, connection, ledger);

    const status = await service.status(task.taskId);
    assert.equal(status.finalMessage, "live final only");
    assert.deepEqual(status.finalMessagePointer, { sessionId: "root-session", seq: 1 });
    assert.equal(status.contentUnavailable, false);
    const tail = await service.tail(task.taskId, 0, 10, 10_000);
    assert.equal(
      tail.events.some((event) => JSON.stringify(event.digest).includes("live final only")),
      true,
    );
    assert.equal((await readFile(status.logPath, "utf8")).includes("live final only"), false);

    connection.state = { ...connection.state, availability: "host_unreachable", revision: 2 };
    const offline = await service.status(task.taskId);
    assert.equal(offline.finalMessage, null);
    assert.deepEqual(offline.finalMessagePointer, { sessionId: "root-session", seq: 1 });
    assert.notEqual(offline.contentUnavailable, false);
    const offlineTail = await service.tail(task.taskId, 0, 10, 10_000);
    assert.notEqual(offlineTail.contentUnavailable, false);
    assert.equal(offlineTail.events.some((event) => JSON.stringify(event.digest).includes("live final only")), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
