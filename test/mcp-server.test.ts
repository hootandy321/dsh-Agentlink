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
