import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EventLedger, EventLedgerError } from "../src/event-ledger.js";

const taskId = "dsh_000000000001";

function sessionEvent(seq: number, type: string, data: unknown) {
  return {
    type: "server-request",
    rpcId: `event-${seq}`,
    method: "session/event",
    payload: { type: "session/event", sessionId: "root", event: { type, seq, time: 1000 + seq, data } },
  };
}


function muxFrame(type: "session/queue" | "session/jobs", sessionId: string, body: Record<string, unknown>, rpcId: string) {
  return {
    type: "server-request",
    rpcId,
    method: type,
    payload: { type, sessionId, ...body },
  };
}

function appendQueue(ledger: EventLedger, sessionId: string, rpcId: string, items: unknown[]) {
  return ledger.append(taskId, {
    sourceSessionId: sessionId,
    origin: "root",
    type: "session/queue",
    raw: muxFrame("session/queue", sessionId, { items }, rpcId),
  });
}

function appendJobs(ledger: EventLedger, sessionId: string, rpcId: string, jobs: unknown[]) {
  return ledger.append(taskId, {
    sourceSessionId: sessionId,
    origin: "root",
    type: "session/jobs",
    raw: muxFrame("session/jobs", sessionId, { jobs }, rpcId),
  });
}

async function readLedgerRecords(logPath: string): Promise<Record<string, unknown>[]> {
  const rawText = await readFile(logPath, "utf8");
  return rawText.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function runLedgerWriter(home: string, sessionId: string, count: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "test/support/ledger-writer.ts", home, taskId, sessionId, String(count)],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`ledger writer exited code=${String(code)} signal=${String(signal)}: ${stderr}`));
    });
  });
}

test("EventLedger deduplicates canonical events, folds turns, and rebuilds after restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-ledger-"));
  try {
    const ledger = new EventLedger(home);
    await ledger.append(taskId, { sourceSessionId: "root", sourceSeq: 0, origin: "root", type: "session/event", raw: sessionEvent(0, "turn/start", { turn: 1 }) });
    await ledger.append(taskId, {
      sourceSessionId: "root",
      sourceSeq: 1,
      origin: "root",
      type: "session/event",
      raw: sessionEvent(1, "user/message", { content: [{ type: "text", text: "do it" }] }),
    });
    await ledger.append(taskId, {
      sourceSessionId: "root",
      sourceSeq: 2,
      origin: "root",
      type: "session/event",
      raw: sessionEvent(2, "assistant/message", {
        turn: 1,
        step: 1,
        message: { content: [{ type: "text", text: "done" }] },
      }),
    });
    await ledger.append(taskId, {
      sourceSessionId: "child",
      sourceSeq: 0,
      parentSessionId: "root",
      origin: "subagent",
      type: "session/event",
      raw: {
        type: "session/event",
        sessionId: "child",
        event: { type: "turn/end", seq: 0, time: 1002, data: { turn: 1, reason: { kind: "error" } } },
      },
    });
    await ledger.append(taskId, { sourceSessionId: "root", sourceSeq: 3, origin: "root", type: "session/event", raw: sessionEvent(3, "turn/end", { turn: 1, reason: { kind: "completed" } }) });
    const duplicate = await ledger.append(taskId, { sourceSessionId: "root", sourceSeq: 3, origin: "root", type: "session/event", raw: sessionEvent(3, "turn/end", { turn: 1, reason: { kind: "completed" } }) });

    assert.equal(duplicate, undefined);
    const snapshot = await ledger.snapshot(taskId);
    assert.equal(snapshot.execution, "turn_completed");
    assert.deepEqual(snapshot.finalMessagePointer, { sessionId: "root", seq: 2 });
    assert.equal(snapshot.terminalMissingFinal, false);
    assert.deepEqual(snapshot.watermarks, { root: 3, child: 0 });
    assert.equal(snapshot.cursor, 5);

    const restarted = new EventLedger(home);
    assert.deepEqual(await restarted.snapshot(taskId), snapshot);
    const lines = (await readFile(snapshot.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 5);
    assert.equal(lines[1].coordination.event.type, "user/message");
    assert.equal(JSON.stringify(lines).includes("do it"), false);
    assert.equal(JSON.stringify(lines).includes("done"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("EventLedger serial reports the original append error without an unhandled rejection and then recovers", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-ledger-"));
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const ledger = new EventLedger(home);
    await assert.rejects(
      ledger.append(taskId, { origin: "root", type: "session/event", raw: { type: "session/event" } }),
      (error: unknown) =>
        error instanceof EventLedgerError &&
        error.code === "invalid_record" &&
        error.message === "ledger input is missing sourceSessionId",
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);

    const record = await ledger.append(taskId, {
      sourceSessionId: "root",
      sourceSeq: 0,
      origin: "root",
      type: "session/event",
      raw: sessionEvent(0, "turn/start", { turn: 1 }),
    });
    assert.equal(record?.cursor, 1);
    assert.equal((await ledger.snapshot(taskId)).cursor, 1);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await rm(home, { recursive: true, force: true });
  }
});

test("EventLedger folds pending interactions, accepted responses, bounded tail, and explicit gaps", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-ledger-"));
  try {
    const ledger = new EventLedger(home);
    await ledger.append(taskId, { sourceSessionId: "root", sourceSeq: 0, origin: "root", type: "session/event", raw: sessionEvent(0, "turn/start", { turn: 1 }) });
    await ledger.append(taskId, {
      sourceSessionId: "root",
      origin: "root",
      type: "question/requested",
      raw: {
        type: "server-request",
        rpcId: "question-1",
        method: "question/requested",
        payload: { type: "question/requested", sessionId: "root", questions: [{ id: "q", question: "Continue?" }] },
      },
    });
    assert.equal((await ledger.snapshot(taskId)).execution, "awaiting_input");
    await ledger.append(taskId, {
      sourceSessionId: "root",
      origin: "root",
      type: "respond/accepted",
      raw: { requestId: "question-1", interaction: "question" },
    });
    assert.equal((await ledger.snapshot(taskId)).execution, "running");

    const tail = await ledger.tail(taskId, 0, 10, 1);
    assert.equal(tail.records.some((record) => record.type === "question/requested" && record.protected), true);
    assert.equal(tail.records.some((record) => record.exceededMaxBytes === true), true);

    const wait = ledger.waitForCursor(taskId, tail.nextCursor, 500);
    await ledger.append(taskId, { sourceSessionId: "root", sourceSeq: 1, origin: "root", type: "session/event", raw: sessionEvent(1, "turn/end", { turn: 1, reason: { kind: "interrupted" } }) });
    await wait;

    await ledger.markGap(taskId, { sourceSessionId: "root", expectedSeq: 2, firstRecoveredSeq: 4 });
    await assert.rejects(
      () => ledger.tail(taskId, 0),
      (error: unknown) => error instanceof EventLedgerError && error.code === "unrecoverable_gap" && error.details.earliestCursor === 1,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("EventLedger reloads writes from another instance and allocates cursors under a task lock", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-ledger-"));
  try {
    const left = new EventLedger(home);
    const right = new EventLedger(home);

    await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        const ledger = index % 2 === 0 ? left : right;
        return ledger.append(taskId, {
          sourceSessionId: "root",
          sourceSeq: index,
          origin: "root",
          type: "session/event",
          raw: sessionEvent(index, "assistant/message", {
            turn: 1,
            message: { content: [{ type: "text", text: `secret assistant ${index}` }] },
          }),
        });
      }),
    );

    const leftSnapshot = await left.snapshot(taskId);
    const rightSnapshot = await right.snapshot(taskId);
    assert.equal(leftSnapshot.cursor, 20);
    assert.equal(rightSnapshot.cursor, 20);
    assert.deepEqual(leftSnapshot.watermarks, { root: 19 });
    assert.deepEqual(rightSnapshot.watermarks, { root: 19 });

    const tail = await left.tail(taskId, 0, 25);
    assert.deepEqual(tail.records.map((record) => record.cursor), Array.from({ length: 20 }, (_, index) => index + 1));

    const waitStarted = Date.now();
    const wait = left.waitForCursor(taskId, 20, 1_000);
    await right.append(taskId, {
      sourceSessionId: "root",
      sourceSeq: 20,
      origin: "root",
      type: "session/event",
      raw: sessionEvent(20, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    });
    await wait;
    assert.ok(Date.now() - waitStarted < 500, "cross-instance wait should observe the other writer before timeout");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("EventLedger serializes two operating-system processes without duplicate cursors", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-ledger-process-"));
  try {
    await Promise.all([runLedgerWriter(home, "left", 20), runLedgerWriter(home, "right", 20)]);

    const ledger = new EventLedger(home);
    const snapshot = await ledger.snapshot(taskId);
    assert.equal(snapshot.cursor, 40);
    assert.deepEqual(snapshot.watermarks, { left: 19, right: 19 });
    const rawText = await readFile(snapshot.logPath, "utf8");
    const records = rawText.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.cursor), Array.from({ length: 40 }, (_, index) => index + 1));
    assert.equal(rawText.includes("SECRET"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("EventLedger persists only coordination metadata and tags bridge initiated user messages", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-ledger-"));
  try {
    const ledger = new EventLedger(home);
    await ledger.append(taskId, {
      sourceSessionId: "root",
      origin: "root",
      type: "bridge/prompt-issued",
      raw: { issuedRpcId: "issued-1", mode: "queue", prompt: "SECRET prompt body" },
    });
    await ledger.append(taskId, {
      sourceSessionId: "root",
      sourceSeq: 1,
      origin: "root",
      type: "session/event",
      raw: sessionEvent(1, "user/message", {
        content: [{ type: "text", text: "SECRET user body" }],
        source: { rpcId: "issued-1" },
      }),
    });
    await ledger.append(taskId, {
      sourceSessionId: "root",
      sourceSeq: 2,
      origin: "root",
      type: "session/event",
      raw: sessionEvent(2, "assistant/message", {
        message: { content: [{ type: "text", text: "SECRET assistant body" }] },
      }),
    });
    await ledger.append(taskId, {
      sourceSessionId: "root",
      origin: "root",
      type: "question/requested",
      raw: {
        type: "server-request",
        rpcId: "question-1",
        method: "question/requested",
        payload: { type: "question/requested", sessionId: "root", questions: [{ id: "q", question: "SECRET question body" }] },
      },
    });

    const snapshot = await ledger.snapshot(taskId);
    const rawText = await readFile(snapshot.logPath, "utf8");
    assert.equal(rawText.includes("SECRET"), false);
    assert.equal(rawText.includes("issued-1"), true);
    assert.equal(rawText.includes("queue"), true);

    const records = rawText.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records[0].coordination, { type: "bridge/prompt-issued", issuedRpcId: "issued-1", mode: "queue", sessionId: "root" });
    assert.deepEqual(records[0].metadata, { issuedRpcId: "issued-1" });
    assert.equal(records[1].metadata.initiatedBy, "bridge");
    assert.equal(records[1].metadata.sourceRpcId, "issued-1");
    assert.equal(records[2].coordination.event.type, "assistant/message");
    assert.equal(records[2].coordination.event.data, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("EventLedger deduplicates question resolved by payload questionRpcId before outer rpcId", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-ledger-"));
  try {
    const ledger = new EventLedger(home);
    await ledger.append(taskId, {
      sourceSessionId: "root",
      origin: "root",
      type: "question/resolved",
      raw: {
        type: "server-request",
        rpcId: "outer-a",
        method: "question/resolved",
        payload: { type: "question/resolved", sessionId: "root", questionRpcId: "inner-question", outcome: "answered" },
      },
    });
    const duplicate = await ledger.append(taskId, {
      sourceSessionId: "root",
      origin: "root",
      type: "question/resolved",
      raw: {
        type: "server-request",
        rpcId: "outer-b",
        method: "question/resolved",
        payload: { type: "question/resolved", sessionId: "root", questionRpcId: "inner-question", outcome: "answered" },
      },
    });

    assert.equal(duplicate, undefined);
    assert.equal((await ledger.snapshot(taskId)).cursor, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});


test("EventLedger structurally deduplicates concurrent queue and jobs snapshots across instances", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-ledger-snapshots-"));
  try {
    const ledgers = Array.from({ length: 26 }, () => new EventLedger(home));
    const queueItems = [{ id: "queued-1", placement: "queued", message: { content: "SECRET queue body" }, label: "SECRET label" }];
    const jobs = [{ id: "job-1", kind: "shell", status: "running", startedAt: "2026-08-15T00:00:00.000Z", detail: "SECRET job detail" }];

    await Promise.all(ledgers.map((ledger, index) => appendQueue(ledger, "root", `queue-${index}`, queueItems)));
    await Promise.all(ledgers.map((ledger, index) => appendJobs(ledger, "root", `jobs-${index}`, jobs)));

    const snapshot = await new EventLedger(home).snapshot(taskId);
    assert.equal(snapshot.cursor, 2);
    const records = await readLedgerRecords(snapshot.logPath);
    assert.deepEqual(records.map((record) => record.type), ["session/queue", "session/jobs"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("EventLedger deduplicates live queue fan-out by Host rpcId within one session", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-ledger-snapshot-rpc-"));
  try {
    const ledgers = Array.from({ length: 7 }, () => new EventLedger(home));
    const queued = [{ id: "queued-1", placement: "queued" }];

    for (const ledger of ledgers) {
      await appendQueue(ledger, "root", "queue-rpc-a", queued);
      await appendQueue(ledger, "root", "queue-rpc-b", []);
    }

    assert.equal((await new EventLedger(home).snapshot(taskId)).cursor, 2);

    const restarted = new EventLedger(home);
    assert.equal(await appendQueue(restarted, "root", "queue-rpc-a", queued), undefined);
    const otherSession = await appendQueue(restarted, "child", "queue-rpc-a", queued);
    assert.equal(otherSession?.cursor, 3, "the same rpcId in a different session must remain independent");
    assert.equal((await restarted.snapshot(taskId)).cursor, 3);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("EventLedger snapshot dedupe is last-wins, session/type scoped, and survives restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-ledger-snapshots-"));
  try {
    const ledger = new EventLedger(home);
    await appendQueue(ledger, "root", "queue-a1", []);
    await appendQueue(ledger, "root", "queue-b", [{ id: "queued-1", placement: "queued", message: { content: "SECRET" } }]);
    await appendQueue(ledger, "root", "queue-a2", []);

    let snapshot = await ledger.snapshot(taskId);
    assert.equal(snapshot.cursor, 3, "A to B to A must record each observed state transition");

    await appendQueue(ledger, "child", "queue-child", []);
    await appendJobs(ledger, "root", "jobs-root", [{ id: "job-1", status: "running", detail: "SECRET" }]);
    snapshot = await ledger.snapshot(taskId);
    assert.equal(snapshot.cursor, 5, "same projection under a different session or type is independent");

    const restarted = new EventLedger(home);
    const duplicate = await appendJobs(restarted, "root", "jobs-root-duplicate", [{ id: "job-1", status: "running", label: "SECRET" }]);
    assert.equal(duplicate, undefined);
    assert.equal((await restarted.snapshot(taskId)).cursor, 5);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("EventLedger treats old snapshot records without persisted projection as unknown", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-ledger-old-snapshot-"));
  try {
    const logDir = join(home, "ledgers", taskId);
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    await chmod(join(home, "ledgers"), 0o700);
    await chmod(logDir, 0o700);
    await appendFile(
      join(logDir, "events.jsonl"),
      `${JSON.stringify({
        cursor: 1,
        mergeIndex: 1,
        observedAt: "2026-08-15T00:00:00.000Z",
        sourceSessionId: "root",
        origin: "root",
        type: "session/queue",
        coordination: { type: "session/queue", sessionId: "root", rpcId: "old-queue" },
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const ledger = new EventLedger(home);
    await appendQueue(ledger, "root", "queue-after-upgrade", []);
    const duplicate = await appendQueue(ledger, "root", "queue-after-upgrade-duplicate", []);

    assert.equal(duplicate, undefined);
    assert.equal((await ledger.snapshot(taskId)).cursor, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("EventLedger snapshot projections persist only structural fields", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-ledger-snapshot-secrets-"));
  try {
    const ledger = new EventLedger(home);
    await appendQueue(ledger, "root", "queue-secret", [
      { id: "queued-1", placement: "queued", message: { content: "SECRET queue message" }, label: "SECRET queue label", detail: "SECRET queue detail" },
    ]);
    await appendJobs(ledger, "root", "jobs-secret", [
      { id: "job-1", kind: "shell", status: "running", startedAt: "2026-08-15T00:00:00.000Z", finishedAt: "", message: "SECRET job message", label: "SECRET job label", detail: "SECRET job detail" },
    ]);

    const snapshot = await ledger.snapshot(taskId);
    const rawText = await readFile(snapshot.logPath, "utf8");
    assert.equal(rawText.includes("SECRET"), false);
    assert.equal(rawText.includes("message"), false);
    assert.equal(rawText.includes("label"), false);
    assert.equal(rawText.includes("detail"), false);

    const records = await readLedgerRecords(snapshot.logPath);
    assert.deepEqual(records.map((record) => record.snapshotProjection), [
      { kind: "queue", items: [{ id: "queued-1", placement: "queued" }] },
      { kind: "jobs", items: [{ id: "job-1", kind: "shell", status: "running", startedAt: "2026-08-15T00:00:00.000Z" }] },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
