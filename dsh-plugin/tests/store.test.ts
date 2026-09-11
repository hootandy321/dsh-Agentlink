import test from "node:test";
import assert from "node:assert/strict";
import { AgentlinkStore, memoryTables } from "../src/store.js";

test("registers a run, attaches root session, and summarizes via shared cost core", async () => {
  const store = new AgentlinkStore(memoryTables(), () => new Date("2026-09-09T12:00:00.000Z"));
  const registered = await store.registerInvocation({
    runId: "run-1",
    taskId: "task-1",
    rootSessionId: "session-1",
    caller: { client: "codex", model: { provider: "openai", id: "gpt-6-astra", serviceTier: "standard", source: "caller-reported" } }
  });

  const attribution = store.attributionFor("session-1", "2026-09-09T12:00:01.000Z");
  await store.recordUsage({
    requestRecordId: "req-1",
    sessionId: "session-1",
    ...attribution,
    origin: "delegated",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    startedAt: "2026-09-09T12:00:01.000Z",
    finishedAt: "2026-09-09T12:00:02.000Z",
    status: "finished",
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    usageSource: "llm-stream"
  });

  const summary = store.summary({ sessionId: "session-1" });

  assert.equal(registered.runId, "run-1");
  assert.equal(summary.items.length, 3);
  assert.equal(summary.items[0]?.aggregate.dshCostAllPriced?.picoUsd, "880000000000");
  assert.equal(summary.items[0]?.aggregate.callerEquivalentCost?.picoUsd, "95000000000000");
  assert.equal(summary.items[0]?.aggregate.saving?.picoUsd, "94120000000000");
});

test("listRuns filters by caller client and preserves source grouping metadata", async () => {
  const store = new AgentlinkStore(memoryTables());
  await store.registerInvocation({ runId: "run-codex", taskId: "task-1", rootSessionId: "s1", caller: { client: "codex" } });
  await store.registerInvocation({ runId: "run-claude", taskId: "task-2", rootSessionId: "s2", caller: { client: "claude-code" } });

  const codex = store.listRuns({ callerClient: "codex" });

  assert.equal(codex.length, 1);
  assert.equal(codex[0]?.runId, "run-codex");
  assert.equal(codex[0]?.sessionCount, 1);
});

test("explicit zod validation rejects unknown remote fields", async () => {
  const store = new AgentlinkStore(memoryTables());
  await assert.rejects(
    () => store.registerInvocation({ taskId: "task-1", rootSessionId: "session-1", caller: { client: "codex" }, extra: true } as never),
    /Unrecognized key|unrecognized/i
  );
});

test("child sessions inherit the parent run and avoid inherited history double-counting", async () => {
  const store = new AgentlinkStore(memoryTables());
  await store.registerInvocation({ runId: "run-1", taskId: "task-1", rootSessionId: "parent", caller: { client: "codex" } });
  const child = await store.attachChildSessionFromRuntime({
    id: "child",
    header: { parentSession: "parent", origin: "subagent" },
    inheritedEventCount: 12,
    firstLiveSeq: 13
  });

  assert.equal(child?.runId, "run-1");
  assert.equal(child?.parentSessionId, "parent");
  assert.equal(child?.rootSessionId, "parent");
  assert.equal(child?.origin, "dsh-internal");
  assert.equal(child?.inheritedEventCount, 12);
  assert.equal(store.summary({ runId: "run-1" }).items[0]?.aggregate.requestCount, 0);
});

test("turn-end auto-closes submissions so later manual DSH work is not misattributed", async () => {
  const store = new AgentlinkStore(memoryTables(), () => new Date("2026-09-09T00:00:00.000Z"));
  const registered = await store.registerInvocation({ runId: "run-1", taskId: "task-1", rootSessionId: "session-1", caller: { client: "codex", model: { provider: "openai", id: "gpt-6-astra", source: "caller-reported" } } });
  await store.closeTurnSubmissions("session-1", "2026-09-09T00:00:10.000Z");
  await store.recordUsage({
    requestRecordId: "req-manual",
    sessionId: "session-1",
    origin: "delegated",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    startedAt: "2026-09-09T00:00:11.000Z",
    status: "finished",
    usage: { inputTokens: 10, outputTokens: 10 },
    usageSource: "llm-stream"
  });

  const detail = store.details({ sessionId: "session-1" })[0];
  assert.equal(registered.submissionId.startsWith("sub-"), true);
  assert.equal(detail?.origin, "manual-dsh");
  assert.equal(detail?.caller, undefined);
  assert.deepEqual(store.summary({ sessionId: "session-1" }).items[0]?.aggregate.coverage.missingReasons, { "non-comparable-origin": 1, "caller-model-missing": 1 });
});

test("custom configured prices are merged and exposed with source details", async () => {
  const store = new AgentlinkStore(memoryTables(), () => new Date("2026-09-09T00:00:00.000Z"), {
    prices: [{
      priceId: "custom:local:cheap",
      provider: "local",
      model: "cheap",
      currency: "USD",
      checkedAt: "2026-09-09T00:00:00.000Z",
      sourceUrl: "file://dsh-agentlink-prices.json",
      sourceType: "custom",
      rates: { inputUsdPerMillion: "0.01", outputUsdPerMillion: "0.02" }
    }]
  });
  await store.registerInvocation({ runId: "run-1", taskId: "task-1", rootSessionId: "session-1", caller: { client: "codex", model: { provider: "openai", id: "gpt-5.6", serviceTier: "standard", source: "caller-reported" } } });
  const attribution = store.attributionFor("session-1", "2026-09-09T00:00:01.000Z");
  await store.recordUsage({ requestRecordId: "req-1", sessionId: "session-1", ...attribution, origin: "delegated", provider: "local", model: "cheap", startedAt: "2026-09-09T00:00:01.000Z", status: "finished", usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 }, usageSource: "llm-stream" });

  const request = store.details({ sessionId: "session-1" })[0];
  const aggregate = store.summary({ sessionId: "session-1" }).items[0]?.aggregate;
  assert.equal("requests" in (aggregate as object), false);
  assert.equal(aggregate?.dshCostAllPriced?.picoUsd, "30000000000");
  assert.equal(request?.provider, "local");
  assert.ok(store.prices().some((price) => price.priceId === "custom:local:cheap" && price.sourceType === "custom"));
});


test("pending child sessions attach when the parent is registered later", async () => {
  const store = new AgentlinkStore(memoryTables());
  assert.equal(await store.attachChildSessionFromRuntime({ id: "child", header: { parentSession: "parent", origin: "subagent" } }), undefined);
  await store.registerInvocation({ runId: "run-1", taskId: "task-1", rootSessionId: "parent", caller: { client: "codex" } });

  const run = store.listRuns({ limit: 1 })[0];
  assert.equal(run?.sessionCount, 2);
});

test("memory fallback is visible in summary notes", () => {
  const store = new AgentlinkStore(memoryTables(), () => new Date("2026-09-09T00:00:00.000Z"), {}, "memory");
  assert.ok(store.summary().notes.includes("storage-memory-fallback"));
});

test("child attribution inherits the parent submission for its first turn only", async () => {
  const store = new AgentlinkStore(memoryTables());
  const registered = await store.registerInvocation({
    runId: "run-1",
    taskId: "task-1",
    rootSessionId: "parent",
    caller: { client: "codex", model: { provider: "openai", id: "gpt-5.6-sol", serviceTier: "standard", source: "caller-reported" } }
  });
  await store.attachChildSessionFromRuntime({ id: "child", header: { parentSession: "parent", origin: "subagent" } });

  const inherited = store.attributionFor("child", "2026-09-09T00:00:01.000Z");
  assert.equal(inherited.submissionId, registered.submissionId);
  assert.equal(inherited.caller?.client, "codex");

  await store.closeTurnSubmissions("child", "2026-09-09T00:00:02.000Z");
  const later = store.attributionFor("child", "2026-09-09T00:00:03.000Z");
  assert.equal(later.submissionId, undefined);
  assert.equal(later.caller, undefined);
});

test("recordUsage preserves an already-sampled unknown attribution", async () => {
  const store = new AgentlinkStore(memoryTables());
  await store.registerInvocation({ runId: "run-1", taskId: "task-1", rootSessionId: "session-1", caller: { client: "codex" } });
  await store.recordUsage({ requestRecordId: "req-1", sessionId: "session-1", origin: "delegated", provider: "custom", model: "m", startedAt: "2026-09-09T00:00:00.000Z", status: "finished", usage: { inputTokens: 1, outputTokens: 1 }, usageSource: "llm-stream" });

  const record = store.details({ sessionId: "session-1" })[0];
  assert.equal(record?.submissionId, undefined);
  assert.equal(record?.origin, "manual-dsh");
});


test("historical registerInvocation does not create an active submission", async () => {
  const store = new AgentlinkStore(memoryTables());
  const registered = await store.registerInvocation({ runId: "run-h", taskId: "task-h", rootSessionId: "session-h", caller: { client: "codex" }, historical: true });

  assert.equal(registered.registered, true);
  assert.equal(registered.submissionId, undefined);
  const attribution = store.attributionFor("session-h", new Date().toISOString());
  assert.equal(attribution.submissionId, undefined);
  assert.equal(store.listRuns({ callerClient: "codex" })[0]?.runId, "run-h");
});


test("sessions endpoint returns lightweight run session records", async () => {
  const store = new AgentlinkStore(memoryTables());
  await store.registerInvocation({ runId: "run-1", taskId: "task-1", rootSessionId: "parent", caller: { client: "codex" } });
  await store.attachChildSessionFromRuntime({ id: "child", header: { parentSession: "parent", origin: "subagent" } });

  const sessions = store.sessions({ runId: "run-1" });
  assert.equal(sessions.length, 2);
  assert.equal(sessions.some((session) => session.sessionId === "child" && session.parentSessionId === "parent"), true);
});

test("registerInvocation keeps the first run caller and title while submissions keep their own caller", async () => {
  const store = new AgentlinkStore(memoryTables());
  await store.registerInvocation({
    runId: "run-shared",
    taskId: "task-1",
    rootSessionId: "s1",
    title: "first title",
    caller: { client: "codex", model: { provider: "openai", id: "gpt-6-astra" } }
  });
  const second = await store.registerInvocation({
    runId: "run-shared",
    taskId: "task-2",
    rootSessionId: "s2",
    title: "second title",
    caller: { client: "claude-code", model: { provider: "anthropic", id: "claude" } }
  });

  const run = store.listRuns({})[0];
  assert.equal(run?.caller.client, "codex");
  assert.equal(run?.title, "first title");
  const secondAttribution = store.attributionFor("s2", new Date().toISOString());
  assert.equal(secondAttribution.submissionId, second.submissionId);
  assert.equal(secondAttribution.caller?.client, "claude-code");
});

test("concurrent registerInvocation calls for one run preserve all task and root session ids", async () => {
  const tables = memoryTables();
  const basePut = tables.runs.put.bind(tables.runs);
  tables.runs.put = async (key, value) => {
    await new Promise((resolve) => setTimeout(resolve, key === "run-race" ? 5 : 0));
    return basePut(key, value);
  };
  const store = new AgentlinkStore(tables);

  await Promise.all([
    store.registerInvocation({ runId: "run-race", taskId: "task-a", rootSessionId: "s-a", caller: { client: "codex" } }),
    store.registerInvocation({ runId: "run-race", taskId: "task-b", rootSessionId: "s-b", caller: { client: "codex" } })
  ]);

  const sessions = store.sessions({ runId: "run-race" });
  assert.deepEqual(new Set(sessions.map((session) => session.taskId)), new Set(["task-a", "task-b"]));
  assert.deepEqual(new Set(sessions.map((session) => session.rootSessionId)), new Set(["s-a", "s-b"]));
});

test("sessions endpoint includes only official catalog-derived subagent addresses", async () => {
  const store = new AgentlinkStore(memoryTables());
  await store.registerInvocation({ runId: "run-addr", taskId: "task-1", rootSessionId: "parent", caller: { client: "codex" } });
  await store.attachChildSessionFromRuntime({ id: "child", header: { parentSession: "parent", origin: "subagent" } });

  const withoutCatalog = store.sessions({ runId: "run-addr" });
  assert.equal(withoutCatalog.find((session) => session.sessionId === "child")?.subagentAddress, undefined);

  const withCatalog = store.sessions({ runId: "run-addr" }, (sessionId) => sessionId === "child" ? { parentSessionId: "parent", childSessionId: "child", mode: "continuable" } : undefined);
  assert.deepEqual(withCatalog.find((session) => session.sessionId === "child")?.subagentAddress, { parentSessionId: "parent", childSessionId: "child", mode: "continuable" });
});


test("overlapping active submissions do not latest-win caller attribution", async () => {
  const store = new AgentlinkStore(memoryTables());
  await store.registerInvocation({
    runId: "run-overlap",
    taskId: "task-1",
    rootSessionId: "session-1",
    caller: { client: "codex", model: { provider: "openai", id: "gpt-6-astra", serviceTier: "standard" } },
    submittedAt: "2026-09-09T00:00:00.000Z"
  });
  await store.registerSubmission({
    runId: "run-overlap",
    taskId: "task-1",
    sessionId: "session-1",
    caller: { client: "claude-code", model: { provider: "openai", id: "gpt-5.6-sol", serviceTier: "standard" } },
    submittedAt: "2026-09-09T00:00:01.000Z"
  });

  const attribution = store.attributionFor("session-1", "2026-09-09T00:00:02.000Z");
  assert.equal(attribution.submissionId, undefined);
  assert.equal(attribution.caller, undefined);

  await store.recordUsage({
    requestRecordId: "req-overlap",
    sessionId: "session-1",
    ...attribution,
    origin: "delegated",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    startedAt: "2026-09-09T00:00:02.000Z",
    finishedAt: "2026-09-09T00:00:03.000Z",
    status: "finished",
    usage: { inputTokens: 1000, outputTokens: 1000 },
    usageSource: "llm-stream"
  });

  const detail = store.details({ sessionId: "session-1" })[0];
  assert.equal(detail?.caller, undefined);
  assert.equal(detail?.submissionId, undefined);
  assert.equal(detail?.origin, "manual-dsh");
  const runAggregate = store.summary({ runId: "run-overlap" }).items.find((item) => item.scope === "run")?.aggregate;
  assert.equal(runAggregate?.coverage.dshPricedRequests, 1);
  assert.equal(runAggregate?.coverage.comparableRequests, 0);
});


test("registered identities cannot be remapped by later invocation or submission", async () => {
  const store = new AgentlinkStore(memoryTables());
  const original = { runId: "original", taskId: "task", rootSessionId: "root", caller: { client: "codex" } };
  await store.registerInvocation(original);
  await assert.rejects(store.registerInvocation({ ...original, runId: "other" }), /already registered/);
  await assert.rejects(store.attachSession({runId:"other",taskId:"task",sessionId:"root"}), /registered task/);
  await assert.rejects(store.registerSubmission({runId:"other",taskId:"task",sessionId:"root",caller:{client:"codex"}}), /registered session/);
  assert.equal(store.sessions({runId:"original"})[0]?.sessionId,"root");
});
