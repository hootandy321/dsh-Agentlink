import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { BridgeService } from "../src/bridge-service.js";
import type { BridgeConfig } from "../src/config.js";
import type { DshHistoryEntry } from "../src/dsh-types.js";
import { EventLedger } from "../src/event-ledger.js";
import { createMcpServer } from "../src/mcp-server.js";
import { TaskStore } from "../src/task-store.js";
import { WorkspaceClaimStore } from "../src/workspace-claim.js";
import { FakeConnection, FakeDshApi } from "./support/fakes.js";

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("expected text tool result");
  return block.text;
}

function parseToolText(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return JSON.parse(toolText(result)) as Record<string, unknown>;
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
    const waitTool = tools.tools.find((tool) => tool.name === "dsh_wait");
    assert.match(waitTool?.description ?? "", /ignore ordinary cursor\/queue\/status churn/);
    assert.match(JSON.stringify(waitTool?.inputSchema), /terminal/);
    assert.match(JSON.stringify(waitTool?.inputSchema), /compact/);

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

    const status = await client.callTool({ name: "dsh_status", arguments: { taskId: task.taskId } });
    assert.deepEqual(parseToolText(status).workspaceClaimSemantics, {
      enforcement: "bridge-cooperative-only",
      controlsDshSandbox: false,
      description:
        "workspaceMode is a bridge-local coordination claim shared only by bridge processes using the same bridge home; it does not select, enforce, or verify the DSH Host filesystem sandbox.",
    });

    connection.pending = [
      {
        type: "server-request",
        rpcId: "pending-question",
        method: "question/requested",
        payload: {
          type: "question/requested",
          sessionId: "root-session",
          questions: [{ id: "q1", question: "Continue?", options: [{ label: "yes" }] }],
        },
      },
    ];
    const waited = await client.callTool({
      name: "dsh_wait",
      arguments: { taskId: task.taskId, timeoutSec: 0 },
    });
    const waitedBody = parseToolText(waited);
    assert.equal(waitedBody.wakeReason, "interaction");
    assert.equal(waitedBody.timedOut, false);
    assert.equal("status" in waitedBody, false);
    assert.deepEqual(waitedBody.pendingInteractions, [
      {
        requestId: "pending-question",
        type: "question/requested",
        sessionId: "root-session",
        questions: [{ id: "q1", question: "Continue?", options: [{ label: "yes" }] }],
      },
    ]);
    assert.equal(toolText(waited).includes('"method"'), false);
    connection.pending = [];

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
    assert.equal(parseToolText(failure).code, "queue_snapshot_unavailable");
  } finally {
    await client.close();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("dsh_wait defaults to compact terminal waiting and suppresses intermediate task changes", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-mcp-wait-"));
  const api = new FakeDshApi();
  const tasks = new TaskStore(home);
  const task = await tasks.create("root-session");
  const ledger = new EventLedger(home);
  const historyEntries: DshHistoryEntry[] = [];
  const appendHistory = async (entry: DshHistoryEntry) => {
    historyEntries.push(entry);
    await ledger.append(task.taskId, {
      sourceSessionId: "root-session",
      sourceSeq: entry.event.seq,
      origin: "root",
      type: "session/event",
      raw: { type: "session/event", sessionId: "root-session", event: entry.event },
    });
  };
  await appendHistory({
    event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
  });

  class ScriptedConnection extends FakeConnection {
    waitCalls = 0;

    override async waitForTaskChange(
      taskId: string,
      _afterCursor: number,
      _afterRevision: number,
      _waitMs: number,
    ) {
      this.waitCalls += 1;
      if (this.waitCalls <= 2) {
        await appendHistory({
          event: {
            type: "tool/call",
            seq: this.waitCalls,
            time: this.waitCalls + 1,
            data: { name: `intermediate-${this.waitCalls}` },
          },
        });
      } else {
        await appendHistory({
          event: {
            type: "assistant/message",
            seq: 3,
            time: 4,
            data: { turn: 1, step: 3, message: { content: [{ type: "text", text: "done" }] } },
          },
        });
        await appendHistory({
          event: { type: "turn/end", seq: 4, time: 5, data: { turn: 1, reason: { kind: "completed" } } },
        });
        this.lineage = [
          {
            sessionId: "root-session",
            found: true,
            origin: "root",
            running: false,
            blank: false,
            historyCapability: "session.history",
          },
        ];
        this.histories.set("root-session", { events: structuredClone(historyEntries), hasMore: false });
      }
      this.state = { ...this.state, revision: this.state.revision + 1 };
      return { timedOut: false, connection: this.snapshot(), ledger: await ledger.snapshot(taskId) };
    }
  }

  const connection = new ScriptedConnection(ledger);
  connection.lineage = [
    { sessionId: "root-session", found: true, origin: "root", running: true, blank: false, historyCapability: "session.history" },
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
    const waited = await client.callTool({
      name: "dsh_wait",
      arguments: { taskId: task.taskId, timeoutSec: 5 },
    });
    const text = toolText(waited);
    const body = parseToolText(waited);

    assert.equal(connection.waitCalls, 3);
    assert.equal(body.timedOut, false);
    assert.equal(body.wakeReason, "terminal");
    assert.equal(body.availability, "connected");
    assert.equal(body.execution, "turn_completed");
    assert.equal(body.nextCursor, 5);
    assert.equal(body.finalMessage, "done");
    assert.equal("status" in body, false);
    assert.equal("connection" in body, false);
    assert.equal("lineage" in body, false);
    assert.equal("watermarks" in body, false);
    assert.ok(Buffer.byteLength(text, "utf8") < 1_000, `compact wait response was ${Buffer.byteLength(text, "utf8")} bytes`);

    const full = await client.callTool({
      name: "dsh_wait",
      arguments: {
        taskId: task.taskId,
        timeoutSec: 0,
        sinceCursor: 5,
        until: "change",
        responseMode: "full",
      },
    });
    const fullBody = parseToolText(full);
    assert.equal(fullBody.wakeReason, "terminal");
    assert.equal(typeof fullBody.status, "object");
    assert.equal(connection.waitCalls, 3);
  } finally {
    await client.close();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});
