import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { TypertGatewayService } from "@deepseek-ai/dsh-api-gateway";
import * as companion from "../lib/index.js";

test("packed companion dispatches through the published DSH 0.1.5 Remote gateway", async () => {
  const ctx = new Context();
  let dispatch: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<any>) | undefined;
  ctx.reflect.provide("connection", { rpc: { intercept: (_prefix: string, _claims: unknown, handler: typeof dispatch) => {
    dispatch = handler;
    return () => {};
  } } });
  for (const service of ["llm", "sessions", "agents", "subagents"]) ctx.reflect.provide(service, {});
  const registry = ctx.plugin(TypertRegistry);
  const gateway = ctx.plugin(TypertGatewayService, {});
  const plugin = ctx.plugin(companion);
  try {
    await registry.await(); await gateway.await(); await plugin.await();
    assert.ok(dispatch, "official gateway must register the HTTP dispatcher");
    const call = async (method: string, input?: unknown) => {
      const result = await dispatch!(`agentlink/${method}`, { args: input === undefined ? {} : { input } }, new AbortController().signal);
      assert.equal(result.ok, true, JSON.stringify(result));
      // The HTTP carrier serializes the result, including absent optional fields.
      return JSON.parse(JSON.stringify(result)).value;
    };
    const registered = await call("registerInvocation", {
      runId: "run-latest", taskId: "task-latest", rootSessionId: "session-latest", caller: { client: "codex" },
    });
    const summary = await call("summary", { sessionId: "session-latest" });
    assert.equal(summary.runId, "run-latest");
    assert.ok(summary.items.some((item: any) => item.scope === "session"));
    assert.equal((await call("listRuns", {}))[0].runId, "run-latest");
    assert.equal((await call("sessions", { runId: "run-latest" }))[0].sessionId, "session-latest");
    assert.deepEqual(await call("details", { sessionId: "session-latest" }), []);
    assert.ok((await call("prices")).length > 0);
    await call("closeSubmission", { submissionId: registered.submissionId });
    const invalid = await dispatch!("agentlink/summary", { args: { input: { unexpected: true } } }, new AbortController().signal);
    assert.equal(invalid.ok, false);
    const invalidEnvelope = await dispatch!("agentlink/summary", { args: { wrong: {} } }, new AbortController().signal);
    assert.equal(invalidEnvelope.ok, false);
    await plugin.dispose();
    const unloaded = await dispatch!("agentlink/summary", { args: { input: {} } }, new AbortController().signal);
    assert.equal(unloaded.ok, false);
  } finally {
    await ctx.fiber.dispose();
  }
});
