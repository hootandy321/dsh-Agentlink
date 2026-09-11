import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { RemoteDshClient, remoteHistoryEntries } from "../src/remote-client.js";
import { getDshUnaryMetadata, type DshMuxFrame, type DshServerRequest } from "../src/dsh-types.js";

type HostOptions = {
  sessionList?: any[];
  subagentsByParent?: Record<string, any[]>;
  events?: any[];
  control?: any[];
  followSnapshots?: Record<string, any>;
};

async function host(options: HostOptions = {}) {
  const requests: any[] = [];
  const wsFrames: any[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(303, { "set-cookie": "dsh=test; HttpOnly", location: "/" });
      res.end();
      return;
    }
    assert.equal(req.headers.cookie, "dsh=test");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const endpoint = req.url!.slice(5);
    const args = body.payload.args;
    const value = endpoint === "session/list" ? { items: options.sessionList ?? [] }
      : endpoint === "agentPresets/list" ? { presets: [{ id: "code", trust: "system", isDefault: true }], authorable: true }
      : endpoint === "session/page" ? { records: [], hasMore: false }
      : endpoint === "subagents/list" ? { entries: options.subagentsByParent?.[args.parentSessionId] ?? [], parentAvailable: true }
      : endpoint === "$events/result" ? undefined
      : { accepted: true };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value } }));
  });
  const ws = new WebSocketServer({ server });
  ws.on("connection", (socket, req) => {
    assert.equal(req.headers.cookie, "dsh=test");
    socket.on("message", raw => {
      const frame = JSON.parse(raw.toString());
      wsFrames.push(frame);
      const send = (value: unknown) => socket.send(JSON.stringify({ type: "item", streamId: frame.streamId, value }));
      if (frame.endpoint === "session/follow") {
        const id = frame.payload.args.request.address.sessionId ?? frame.payload.args.request.address.childSessionId;
        send(options.followSnapshots?.[id] ?? { type: "snapshot", cursor: 4, records: [{ type: "event", event: { seq: 4, time: 1, type: "agent/idle", data: {} } }], hasMore: true });
      }
      if (frame.endpoint === "$events") {
        send({ type: "ready", clientId: "client" });
        for (const event of options.events ?? [{ type: "waterfall", event: "approval/request", eventId: "unrelated", agentId: "not-ours", request: { toolName: "shell" } }]) send(event);
      }
      if (frame.endpoint === "session/control") {
        for (const value of options.control ?? []) send(value);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    wsFrames,
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    close: async () => {
      for (const s of ws.clients) s.terminate();
      await new Promise<void>(resolve => ws.close(() => server.close(() => resolve())));
    },
  };
}

function nextFrame(iterator: AsyncIterator<DshServerRequest<DshMuxFrame>>) {
  return Promise.race([
    iterator.next(),
    delay(1000).then(() => assert.fail("timed out waiting for mux frame")),
  ]);
}

async function waitForPayload(
  iterator: AsyncIterator<DshServerRequest<DshMuxFrame>>,
  type: DshMuxFrame["type"],
) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const next = await nextFrame(iterator);
    if (next.done) assert.fail(`mux closed before ${type}`);
    if (next.value.payload.type === type) return next;
  }
  assert.fail(`timed out waiting for ${type}`);
}

async function waitForRequest(requests: any[], method: string) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const request = requests.find(r => r.method === method);
    if (request) return request;
    await delay(10);
  }
  assert.fail(`timed out waiting for ${method} request`);
}

async function expectNoFrame(iterator: AsyncIterator<DshServerRequest<DshMuxFrame>>, signal: AbortController) {
  const result = await Promise.race([
    iterator.next(),
    delay(120).then(() => "none" as const),
  ]);
  assert.equal(result, "none");
  signal.abort();
  const done = await Promise.race([
    iterator.next(),
    delay(1000).then(() => assert.fail("timed out waiting for mux close")),
  ]);
  assert.equal(done.done, true);
}

test("Remote uses rc1 cookie exchange and named args; prompt metadata is durable request id", async () => {
  const h = await host();
  try {
    const client = new RemoteDshClient(h.url, 1000, "test-token");
    const receipt = await client.sessionPrompt({ sessionId: "session", mode: "queue", content: [{ type: "text", text: "test" }] });
    assert.equal(h.requests[0].method, "session/prompt");
    assert.equal(getDshUnaryMetadata(receipt).issuedRpcId, h.requests[0].payload.args.request.requestId);
    assert.notEqual(getDshUnaryMetadata(receipt).issuedRpcId, h.requests[0].rpcId);
  } finally { await h.close(); }
});

test("Remote history uses observed cursor, never a speculative maximum", async () => {
  const h = await host();
  try {
    const client = new RemoteDshClient(h.url, 1000, "test-token");
    assert.equal((await client.sessionHistory("session")).events[0]!.event.seq, 4);
    await client.sessionHistory("session", { beforeSeq: 4 });
    assert.equal(h.requests[0].payload.args.request.throughSeq, 4);
  } finally { await h.close(); }
});

test("compressed rows preserve every sequence position without text retention", () => {
  const events = remoteHistoryEntries([{ type: "chunks", event: { type: "chunkrow/text-chunks", seq: 10, time: 100, data: { texts: ["secret", "text"], dt: [5] } } }]);
  assert.deepEqual(events.map(row => row.event.seq), [10, 11]);
  assert.equal(JSON.stringify(events).includes("secret"), false);
});

test("unowned waterfall continues to DSH and never becomes bridge pending work", async () => {
  const h = await host();
  const ac = new AbortController();
  try {
    const client = new RemoteDshClient(h.url, 1000, "test-token");
    const timer = setTimeout(() => ac.abort(), 200);
    for await (const frame of client.openMux(ac.signal)) assert.fail(`unexpected frame ${frame.payload.type}`);
    clearTimeout(timer);
    assert.equal((await waitForRequest(h.requests, "$events/result")).payload.args.outcome.kind, "next");
  } finally { ac.abort(); await h.close(); }
});

test("owned rc1 question and approval become typed pending controls and respond through $events/result", async () => {
  const h = await host({
    events: [
      { type: "waterfall", event: "user-questions/request", eventId: "q-event", agentId: "root", request: { questions: [{ id: "q1", question: "Proceed?" }] } },
      { type: "waterfall", event: "approval/request", eventId: "approval-event", agentId: "root", request: { toolName: "shell", callId: "call-1", reason: "needs shell" } },
    ],
  });
  const ac = new AbortController();
  try {
    const client = new RemoteDshClient(h.url, 1000, "test-token");
    client.trackSessions([{ sessionId: "root" }]);
    const iterator = client.openMux(ac.signal)[Symbol.asyncIterator]();

    const question = await waitForPayload(iterator, "question/requested");
    assert.equal(question.value.method, "question/requested");
    assert.equal(question.value.rpcId, "q-event");
    assert.equal(question.value.payload.sessionId, "root");
    assert.equal(question.value.payload.questions[0]?.id, "q1");

    const approval = await waitForPayload(iterator, "approval/requested");
    assert.equal(approval.value.method, "approval/requested");
    assert.equal(approval.value.rpcId, "approval-event");
    assert.equal(approval.value.payload.sessionId, "root");
    assert.equal(approval.value.payload.approvalId, "approval-event");
    assert.equal(approval.value.payload.toolName, "shell");

    assert.deepEqual(await client.respond({ type: "client-response", rpcId: "q-event", result: { ok: true, value: { sessionId: "root", answer: { answers: [{ id: "q1", selected: ["yes"] }] } } } }), { accepted: true });
    assert.deepEqual(await client.respond({ type: "client-response", rpcId: "approval-event", result: { ok: true, value: { sessionId: "root", approvalId: "approval-event", outcome: "allowed-once" } } }), { accepted: true });

    const results = h.requests.filter(r => r.method === "$events/result").map(r => r.payload.args);
    assert.equal(results[0].eventId, "q-event");
    assert.deepEqual(results[0].outcome, { kind: "result", value: { answers: [{ id: "q1", selected: ["yes"] }] } });
    assert.equal(results[1].eventId, "approval-event");
    assert.deepEqual(results[1].outcome, { kind: "result", value: "allowed-once" });
  } finally { ac.abort(); await h.close(); }
});

test("stale cancel is ignored without producing a resolved control", async () => {
  const h = await host({ events: [{ type: "cancel", eventId: "never-pending" }] });
  const ac = new AbortController();
  try {
    const client = new RemoteDshClient(h.url, 1000, "test-token");
    const iterator = client.openMux(ac.signal)[Symbol.asyncIterator]();
    await expectNoFrame(iterator, ac);
  } finally { ac.abort(); await h.close(); }
});

test("pending response rejects wrong session or approval id and accepts the matching approval", async () => {
  const h = await host({ events: [{ type: "waterfall", event: "approval/request", eventId: "approval-event", agentId: "root", request: { toolName: "shell" } }] });
  const ac = new AbortController();
  try {
    const client = new RemoteDshClient(h.url, 1000, "test-token");
    client.trackSessions([{ sessionId: "root" }]);
    const iterator = client.openMux(ac.signal)[Symbol.asyncIterator]();
    const approval = await waitForPayload(iterator, "approval/requested");
    assert.equal(approval.value.payload.type, "approval/requested");

    assert.deepEqual(await client.respond({ type: "client-response", rpcId: "approval-event", result: { ok: true, value: { sessionId: "other", approvalId: "approval-event", outcome: "allowed-once" } } }), { accepted: false, reason: "bad-response" });
    assert.deepEqual(await client.respond({ type: "client-response", rpcId: "approval-event", result: { ok: true, value: { sessionId: "root", approvalId: "wrong", outcome: "allowed-once" } } }), { accepted: false, reason: "bad-response" });
    assert.equal(h.requests.filter(r => r.method === "$events/result").length, 0);

    assert.deepEqual(await client.respond({ type: "client-response", rpcId: "approval-event", result: { ok: true, value: { sessionId: "root", approvalId: "approval-event", outcome: "rejected" } } }), { accepted: true });
    assert.equal(h.requests.find(r => r.method === "$events/result").payload.args.outcome.value, "rejected");
  } finally { ac.abort(); await h.close(); }
});

test("control baseline projections are emitted on every mux generation", async () => {
  const baseline = { type: "baseline", value: { queues: {}, jobs: {}, projections: { root: { asOfSeq: 7, values: { modelSelection: { next: { provider: "deepseek-official", model: "deepseek-v4-flash" } } } } } } };
  const h = await host({ events: [], control: [baseline] });
  try {
    const client = new RemoteDshClient(h.url, 1000, "test-token");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ac = new AbortController();
      client.trackSessions([{ sessionId: "root" }]);
      const iterator = client.openMux(ac.signal)[Symbol.asyncIterator]();
      const frame = await nextFrame(iterator);
      assert.equal(frame.value.payload.type, "session/projection");
      assert.equal(frame.value.payload.sessionId, "root");
      assert.equal(frame.value.payload.key, "modelSelection");
      assert.equal(frame.value.payload.seq, 7);
      ac.abort();
      await iterator.next();
    }
  } finally { await h.close(); }
});

test("owned descendant waterfall resolves via subagents/list and follows the parent-addressed subagent route", async () => {
  const h = await host({
    sessionList: [
      { sessionId: "root", updatedAt: 1, running: false, blank: false },
      { sessionId: "child", parentSessionId: "root", origin: "subagent", updatedAt: 2, running: true, blank: false },
    ],
    subagentsByParent: { root: [{ kind: "child", id: "child", activity: "running", hasChildren: false, mode: "continuable", label: "worker" }] },
    events: [{ type: "waterfall", event: "approval/request", eventId: "child-approval", agentId: "child", request: { toolName: "shell" } }],
  });
  const ac = new AbortController();
  try {
    const client = new RemoteDshClient(h.url, 1000, "test-token");
    client.trackSessions([{ sessionId: "root" }]);
    const iterator = client.openMux(ac.signal)[Symbol.asyncIterator]();
    const approval = await waitForPayload(iterator, "approval/requested");

    assert.equal(approval.value.payload.type, "approval/requested");
    assert.equal(approval.value.payload.sessionId, "child");
    assert.equal(approval.value.payload.approvalId, "child-approval");
    assert.ok(h.requests.some(r => r.method === "subagents/list" && r.payload.args.parentSessionId === "root"));

    await delay(20);
    const childFollow = h.wsFrames.find(frame => frame.endpoint === "session/follow" && frame.payload.args.request.address.childSessionId === "child");
    assert.deepEqual(childFollow.payload.args.request.address, { kind: "subagent", parentSessionId: "root", childSessionId: "child", mode: "continuable" });
  } finally { ac.abort(); await h.close(); }
});

test("waterfall cancelled during ownership lookup never reappears as pending", async () => {
  const h = await host({
    events: [
      { type: "waterfall", event: "approval/request", eventId: "cancel-during-lookup", agentId: "child", request: { toolName: "shell" } },
      { type: "cancel", eventId: "cancel-during-lookup" },
    ],
    sessionList: [
      { sessionId: "root", updatedAt: 1, running: true, blank: false },
      { sessionId: "child", parentSessionId: "root", origin: "subagent", updatedAt: 1, running: true, blank: false },
    ],
    subagentsByParent: { root: [{ kind: "child", id: "child", activity: "running", mode: "one-shot", hasChildren: false }] },
  });
  const ac = new AbortController();
  try {
    const client = new RemoteDshClient(h.url, 1000, "test-token");
    client.trackSessions([{ sessionId: "root" }]);
    const timer = setTimeout(() => ac.abort(), 150);
    for await (const envelope of client.openMux(ac.signal)) assert.notEqual(envelope.payload.type, "approval/requested");
    clearTimeout(timer);
  } finally { ac.abort(); await h.close(); }
});


test("signed cookie authentication survives launch-token changes without exposing secrets", async () => {
  let requests = 0;
  const client = new RemoteDshClient("http://127.0.0.1:3080", 1000, "old-token", async (_url, init) => {
    requests++;
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string,string>).cookie, "dsh=signed.cookie");
    const input = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({rpcId:input.rpcId,result:{ok:true,value:{items:[]}}}));
  }, "dsh=signed.cookie");
  assert.deepEqual((await client.sessionList()).items, []);
  assert.equal(requests,1);
  assert.throws(() => new RemoteDshClient("http://127.0.0.1:3080",1000,undefined,undefined,"dsh=bad\r\nheader=oops"),/invalid DSH_HOST_COOKIE format/);
});


test("released Remote preset roster preserves verification without the legacy hasDocument field", async () => {
  const h = await host();
  try {
    const client = new RemoteDshClient(h.url, 1000, "test");
    const roster = await client.agentPresetList();
    assert.equal(roster.presets[0]?.id, "code");
    assert.equal(roster.hasDocument, undefined);
    assert.deepEqual(h.requests[0].payload.args, {});
    assert.equal(h.requests[0].method, "agentPresets/list");
  } finally { await h.close(); }
});

test("DSH 0.1.5 history keeps final messages with embedded streams without opting into live assistant frames", async () => {
  const event = {
    type: "assistant/message", seq: 8, time: 100, surfaceOp: "append",
    data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "Done" }] }, stream: [], usage: { inputTokens: 12, outputTokens: 2 } },
  };
  const h = await host({ followSnapshots: { session: {
    type: "snapshot", header: { sessionId: "session" }, cursor: 9, hasMore: false,
    projections: { asOfSeq: 9, values: {} },
    records: [{ type: "event", event }, { type: "event", event: { type: "turn/end", seq: 9, time: 101, data: { turn: 1, reason: { kind: "completed" } } } }],
  } } });
  try {
    const client = new RemoteDshClient(h.url, 1000, "test-token");
    const history = await client.sessionHistory("session");
    assert.deepEqual(history.events[0]?.event.data, event.data);
    assert.equal(history.events[1]?.event.type, "turn/end");
    assert.equal(history.hasMore, false);
    assert.equal(h.wsFrames[0].payload.args.request.assistantStream, undefined);
  } finally { await h.close(); }
});

for (const [type, field] of [["text-chunks", "texts"], ["reasoning-chunks", "texts"], ["tool-call-chunks", "args"]]) {
  test(`compressed ${type} uses N - 1 successive timestamp gaps`, () => {
    const make = (dt: unknown, parts: unknown = ["private-a", "private-b", "private-c"]) => [{ type: "chunks", event: {
      type: `chunkrow/${type}`, seq: 10, time: 100, data: { [field!]: parts, dt },
    } }];
    const events = remoteHistoryEntries(make([5, 7]));
    assert.deepEqual(events.map(row => [row.event.seq, row.event.time]), [[10, 100], [11, 105], [12, 112]]);
    assert.equal(JSON.stringify(events).includes("private-"), false);
    assert.deepEqual(remoteHistoryEntries(make([], ["one"]))[0]?.event.time, 100);
    for (const gaps of [[0, 5, 7], [5], [5, NaN], [5, "7"]]) {
      assert.throws(() => remoteHistoryEntries(make(gaps)), /invalid compressed history range/);
    }
    assert.throws(() => remoteHistoryEntries(make([], [])), /invalid compressed history range/);
    assert.throws(() => remoteHistoryEntries(make([Number.MAX_SAFE_INTEGER, 1])), /invalid compressed history range/);
  });
}
