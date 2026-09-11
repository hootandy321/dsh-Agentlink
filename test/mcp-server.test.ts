import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { BridgeService } from "../src/bridge-service.js";
import type { BridgeConfig } from "../src/config.js";
import { EventLedger } from "../src/event-ledger.js";
import { createMcpServer } from "../src/mcp-server.js";
import { TaskStore } from "../src/task-store.js";
import { WorkspaceClaimStore } from "../src/workspace-claim.js";
import { FakeConnection, FakeDshApi } from "./support/fakes.js";

function parseToolText(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("expected text tool result");
  return JSON.parse(block.text) as Record<string, unknown>;
}

test("MCP server registers the full typed surface and rejects a delegate model argument", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-mcp-"));
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
  const connection = new FakeConnection(ledger);
  connection.lineage = [
    { sessionId: "root-session", found: true, origin: "root", running: false, blank: true, historyCapability: "session.history" },
  ];
  const config: BridgeConfig = {
    hostUrl: "http://127.0.0.1:3080",
    homeDir: home,
    requestTimeoutMs: 1_000,
    allowRemoteHost: false,
  };
  const service = new BridgeService(config, api, tasks, connection, ledger);
  const server = createMcpServer(service);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    for (const expected of [
      "dsh_host_status",
      "dsh_delegate",
      "dsh_followup",
      "dsh_continue",
      "dsh_status",
      "dsh_tail",
      "dsh_wait",
      "dsh_observe",
      "dsh_cancel",
      "dsh_list",
      "dsh_release_workspace",
      "dsh_answer_question",
      "dsh_resolve_approval",
    ]) {
      assert.equal(names.includes(expected), true, `missing ${expected}`);
    }
    const approval = tools.tools.find((tool) => tool.name === "dsh_resolve_approval");
    assert.equal(approval?.annotations?.destructiveHint, true);
    assert.equal(approval?.annotations?.idempotentHint, false);
    assert.deepEqual(approval?._meta, { "anthropic/requiresUserInteraction": true });
    const delegateTool = tools.tools.find((tool) => tool.name === "dsh_delegate");
    assert.match(delegateTool?.description ?? "", /bridge-local cooperative claim/);
    assert.match(JSON.stringify(delegateTool?.inputSchema), /not a DSH Host filesystem sandbox selector/);

    const invalidDelegate = await client.callTool({
        name: "dsh_delegate",
        arguments: { prompt: "work", cwd: home, model: "must-not-be-accepted" },
      });
    assert.equal(invalidDelegate.isError, true);
    assert.equal(api.calls.some((call) => call.method === "session.create"), false);

    const question = await client.callTool({
      name: "dsh_answer_question",
      arguments: {
        taskId: task.taskId,
        requestId: "question-1",
        answers: [{ id: "q1", selected: ["yes"] }],
      },
    });
    assert.deepEqual(parseToolText(question), {
      requestId: "question-1",
      answers: [{ id: "q1", selected: ["yes"] }],
    });

    const status = await client.callTool({ name: "dsh_status", arguments: { taskId: task.taskId, include: ["workspace"] } });
    assert.deepEqual(parseToolText(status).workspaceClaimSemantics, {
      enforcement: "bridge-cooperative-only",
      controlsDshSandbox: false,
      description:
        "workspaceMode is a bridge-local coordination claim shared only by bridge processes using the same bridge home; it does not select, enforce, or verify the DSH Host filesystem sandbox.",
    });

    const approvalResult = await client.callTool({
      name: "dsh_resolve_approval",
      arguments: { taskId: task.taskId, requestId: "approval-1", outcome: "reject" },
    });
    assert.deepEqual(parseToolText(approvalResult), { requestId: "approval-1", outcome: "reject" });

    connection.queue = { known: false, stale: true, connectionEpoch: 1, items: [] };
    const failure = await client.callTool({
      name: "dsh_cancel",
      arguments: { taskId: task.taskId, scope: "queue" },
    });
    assert.equal(failure.isError, true);
    const failureBody = parseToolText(failure);
    assert.equal(failureBody.code, "queue_snapshot_unavailable");
    assert.deepEqual(failureBody.details, {
      taskId: task.taskId,
      rootSessionId: "root-session",
      availableDetails: true,
      detailsHint: "Use the relevant read tool with explicit include fields for selected details.",
    });

    const cursorFailure = await client.callTool({
      name: "dsh_tail",
      arguments: { taskId: task.taskId, sinceCursor: 999 },
    });
    assert.equal(cursorFailure.isError, true);
    const cursorBody = parseToolText(cursorFailure);
    assert.equal(cursorBody.code, "invalid_cursor");
    assert.deepEqual(cursorBody.details, {
      currentCursor: 0,
      earliestCursor: 0,
      availableDetails: true,
      detailsHint: "Use the relevant read tool with explicit include fields for selected details.",
    });
  } finally {
    await client.close();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP read tools default to compact supervision views with opt-in details", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-mcp-"));
  const api = new FakeDshApi();
  api.sessions = [{ sessionId: "root-session", updatedAt: 1, running: false, blank: false }];
  const tasks = new TaskStore(home);
  const task = await tasks.create("root-session");
  const ledger = new EventLedger(home);
  const history = [
    { event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } } },
    {
      event: {
        type: "user/message",
        seq: 1,
        time: 2,
        data: { content: [{ type: "text", text: "SECRET user prompt" }], source: { kind: "user" } },
      },
    },
    {
      event: {
        type: "assistant/chunk",
        seq: 2,
        time: 3,
        data: { message: { content: [{ type: "text", text: "SECRET stream chunk" }] } },
      },
    },
    {
      event: {
        type: "assistant/message",
        seq: 3,
        time: 4,
        data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "final answer" }] } },
      },
    },
    { event: { type: "turn/end", seq: 4, time: 5, data: { turn: 1, reason: { kind: "completed" } } } },
  ];
  for (const entry of history) {
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
  connection.histories.set("root-session", { events: history, hasMore: false });
  const config: BridgeConfig = {
    hostUrl: "http://127.0.0.1:3080",
    homeDir: home,
    requestTimeoutMs: 1_000,
    allowRemoteHost: false,
  };
  const service = new BridgeService(config, api, tasks, connection, ledger);
  const server = createMcpServer(service);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const compactStatus = parseToolText(
      await client.callTool({ name: "dsh_status", arguments: { taskId: task.taskId } }),
    );
    assert.equal(compactStatus.resultAvailable, true);
    assert.equal("finalMessage" in compactStatus, false);
    assert.equal("pendingInteractions" in compactStatus, false);
    assert.equal("connection" in compactStatus, false);
    assert.equal("lineage" in compactStatus, false);
    assert.equal("logPath" in compactStatus, false);

    const detailedStatus = parseToolText(
      await client.callTool({ name: "dsh_status", arguments: { taskId: task.taskId, include: ["result", "connection", "cost"] } }),
    );
    assert.equal(detailedStatus.finalMessage, "final answer");
    assert.equal(typeof (detailedStatus.connection as Record<string, unknown>).revision, "number");
    assert.equal(((detailedStatus.cost as Record<string, unknown>).summary as Record<string, unknown>).notes instanceof Array, true);

    const completedWait = parseToolText(
      await client.callTool({ name: "dsh_wait", arguments: { taskId: task.taskId, timeoutSec: 0, sinceCursor: 0 } }),
    );
    assert.equal(completedWait.timedOut, false);
    assert.equal(completedWait.reason, "turn_completed");
    assert.equal((completedWait.status as Record<string, unknown>).finalMessage, "final answer");

    const duplicateWait = parseToolText(
      await client.callTool({ name: "dsh_wait", arguments: { taskId: task.taskId, timeoutSec: 0, sinceCursor: 5 } }),
    );
    assert.equal(duplicateWait.timedOut, true);
    assert.equal("finalMessage" in (duplicateWait.status as Record<string, unknown>), false);

    const tail = parseToolText(
      await client.callTool({ name: "dsh_tail", arguments: { taskId: task.taskId, sinceCursor: 0, maxEvents: 10 } }),
    );
    assert.equal("status" in tail, false);
    assert.equal("pendingInteractions" in tail, false);
    assert.equal(tail.nextCursor, 5);
    const text = JSON.stringify(tail);
    assert.equal(text.includes("SECRET user prompt"), false);
    assert.equal(text.includes("SECRET stream chunk"), false);
    assert.equal(text.includes("final answer"), true);
  } finally {
    await client.close();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP wait returns actionable interactions and delegate accepts attribution inputs", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-mcp-"));
  const api = new FakeDshApi();
  const tasks = new TaskStore(home);
  const ledger = new EventLedger(home);
  const connection = new FakeConnection(ledger);
  const config: BridgeConfig = {
    hostUrl: "http://127.0.0.1:3080",
    homeDir: home,
    requestTimeoutMs: 1_000,
    allowRemoteHost: false,
  };
  const service = new BridgeService(config, api, tasks, connection, ledger);
  const server = createMcpServer(service);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const delegated = parseToolText(
      await client.callTool({
        name: "dsh_delegate",
        arguments: {
          prompt: "work",
          cwd: home,
          runId: "run-shared",
          caller: {
            client: "codex",
            conversationId: "conv-1",
            model: { provider: "openai", id: "gpt-6-astra", source: "caller-reported" },
          },
        },
      }),
    );
    assert.equal(delegated.runId, "run-shared");
    assert.equal(delegated.submissionId, "remote-submission-1");
    assert.equal(((delegated.caller as Record<string, any>).model as Record<string, unknown>).id, "gpt-6-astra");
    assert.equal(((delegated.caller as Record<string, any>).model as Record<string, unknown>).serviceTier, "standard");

    const compactStatus = parseToolText(
      await client.callTool({ name: "dsh_status", arguments: { taskId: delegated.taskId } }),
    );
    assert.equal(compactStatus.runId, "run-shared");
    const compactList = parseToolText(await client.callTool({ name: "dsh_list", arguments: {} }));
    assert.equal(((compactList.tasks as Array<Record<string, unknown>>)[0] ?? {}).runId, "run-shared");

    await ledger.append(delegated.taskId as string, {
      sourceSessionId: "root-session",
      sourceSeq: 1,
      origin: "root",
      type: "session/event",
      raw: {
        type: "session/event",
        sessionId: "root-session",
        event: { type: "turn/end", seq: 1, time: 1, data: { turn: 1, reason: { kind: "completed" } } },
      },
    });
    await client.callTool({ name: "dsh_status", arguments: { taskId: delegated.taskId } });
    assert.equal(api.calls.some((call) => call.method === "agentlink.closeSubmission"), false);

    connection.pending = [
      {
        type: "server-request",
        rpcId: "question-1",
        method: "question/requested",
        payload: {
          type: "question/requested",
          sessionId: "root-session",
          questions: [{ id: "q1", question: "Continue?" }],
        },
      },
    ];
    const waited = parseToolText(
      await client.callTool({ name: "dsh_wait", arguments: { taskId: delegated.taskId, timeoutSec: 0 } }),
    );
    const waitStatus = waited.status as Record<string, any>;
    assert.equal(waitStatus.runId, "run-shared");
    assert.equal(waited.reason, "pending_interaction");
    assert.equal(waitStatus.pendingInteractions[0].rpcId, "question-1");
  } finally {
    await client.close();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});
