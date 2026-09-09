import test from "node:test";
import assert from "node:assert/strict";
import { observeLlmStream } from "../src/index.js";
import { AgentlinkStore, memoryTables } from "../src/store.js";

test("llm collector yields original chunks and records final usage", async () => {
  const store = new AgentlinkStore(memoryTables());
  await store.registerInvocation({ runId: "run-1", taskId: "task-1", rootSessionId: "session-1", caller: { client: "codex" } });

  async function* chunks() {
    yield { type: "usage" as const, usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: "finish" as const, reason: { kind: "stop" as const } };
  }

  const seen = [];
  for await (const chunk of observeLlmStream(store, {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    sessionId: "session-1" as never,
    messages: []
  }, chunks)) {
    seen.push(chunk.type);
  }

  assert.deepEqual(seen, ["usage", "finish"]);
  const details = store.details({ sessionId: "session-1" });
  assert.equal(details.length, 1);
  assert.equal(details[0]?.runId, "run-1");
  assert.equal(details[0]?.usage?.inputTokens, 10);
});

test("llm collector keeps the submission snapshot taken at request start", async () => {
  const store = new AgentlinkStore(memoryTables());
  const first = await store.registerInvocation({
    runId: "run-1",
    taskId: "task-1",
    rootSessionId: "session-1",
    caller: { client: "codex", model: { provider: "openai", id: "gpt-6-astra" } }
  });

  async function* chunks() {
    await store.closeSubmission({ submissionId: first.submissionId });
    await store.registerSubmission({
      runId: "run-1",
      taskId: "task-1",
      sessionId: "session-1",
      caller: { client: "claude-code", model: { provider: "openai", id: "gpt-5.6-sol" } }
    });
    yield { type: "usage" as const, usage: { inputTokens: 100, outputTokens: 50 } };
    yield { type: "finish" as const, reason: { kind: "stop" as const } };
  }

  for await (const _chunk of observeLlmStream(store, {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    sessionId: "session-1" as never,
    messages: []
  }, chunks)) {
    // consume stream
  }

  const detail = store.details({ sessionId: "session-1" })[0];
  assert.equal(detail?.submissionId, first.submissionId);
  assert.equal(detail?.caller?.client, "codex");
});

test("llm collector isolates storage failures from the yielded stream", async () => {
  const store = new AgentlinkStore(memoryTables());
  const original = store.recordUsage.bind(store);
  store.recordUsage = async (record) => {
    await original(record);
    throw new Error("medium unavailable");
  };

  async function* chunks() {
    yield { type: "finish" as const, reason: { kind: "stop" as const } };
  }

  const seen = [];
  for await (const chunk of observeLlmStream(store, {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    sessionId: "manual-session" as never,
    messages: []
  }, chunks)) {
    seen.push(chunk.type);
  }

  assert.deepEqual(seen, ["finish"]);
  assert.ok(store.summary({ sessionId: "manual-session" }).notes.includes("collector-errors"));
});


test("llm collector writes a started record before final usage for crash coverage", async () => {
  const store = new AgentlinkStore(memoryTables());
  await store.registerInvocation({ runId: "run-1", taskId: "task-1", rootSessionId: "session-1", caller: { client: "codex" } });

  async function* chunks() {
    const started = store.details({ sessionId: "session-1" });
    assert.equal(started.length, 1);
    assert.equal(started[0]?.status, "started");
    assert.equal(started[0]?.usage, undefined);
    yield { type: "usage" as const, usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: "finish" as const, reason: { kind: "stop" as const } };
  }

  for await (const _chunk of observeLlmStream(store, {
    provider: "fixture",
    model: "fixture-small",
    sessionId: "session-1" as never,
    messages: []
  }, chunks)) {
    // consume stream
  }

  const final = store.details({ sessionId: "session-1" });
  assert.equal(final.length, 1);
  assert.equal(final[0]?.status, "finished");
  assert.equal(final[0]?.usage?.outputTokens, 5);
});
