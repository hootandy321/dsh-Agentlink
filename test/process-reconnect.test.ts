import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { TaskStore } from "../src/task-store.js";
import { startMockDshHost, type MockDshHost } from "./support/mock-dsh-host.js";

const durableEvents = [
  { event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } } },
  {
    event: {
      type: "assistant/message",
      seq: 1,
      time: 2,
      data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "survived host restart" }] } },
    },
  },
  { event: { type: "turn/end", seq: 2, time: 3, data: { turn: 1, reason: { kind: "completed" } } } },
];

function installDurableHostState(host: MockDshHost): void {
  host.setUnaryHandler("host.describe", () => ({
    version: "0.0.1",
    cwd: "/tmp",
    attachedSessions: 1,
    canOpenPath: true,
  }));
  host.setUnaryHandler("session.list", () => ({
    items: [{ sessionId: "durable-session", updatedAt: 1, running: false, blank: false }],
  }));
  host.setUnaryHandler("session.history", () => ({ events: durableEvents, hasMore: false }));
  host.setUnaryHandler("session.models", () => ({
    current: { provider: "deepseek-official", model: "deepseek-v4-flash" },
    routable: true,
    groups: [],
    failures: [],
  }));
  host.setMuxBaseline([{ type: "session/subscribed", sessionId: "durable-session", lastSeq: 2 }]);
}

function toolJson(value: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const first = value.content[0];
  if (first?.type !== "text") throw new Error("expected MCP text result");
  return JSON.parse(first.text) as Record<string, unknown>;
}

async function eventually<T>(operation: () => Promise<T | undefined>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition was not met before timeout${lastError === undefined ? "" : `: ${String(lastError)}`}`);
}

test("a separate bridge process reconnects after mock Host restart and rebuilds durable history", { timeout: 20_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-process-reconnect-"));
  let firstHost: MockDshHost | undefined;
  let secondHost: MockDshHost | undefined;
  let client: Client | undefined;
  try {
    firstHost = await startMockDshHost();
    installDurableHostState(firstHost);
    const port = Number(new URL(firstHost.baseUrl).port);
    const task = await new TaskStore(home).create("durable-session");
    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/index.ts"],
      cwd: process.cwd(),
      env: {
        ...inheritedEnv,
        DSH_HOST_URL: firstHost.baseUrl,
        DSH_BRIDGE_HOME: home,
        DSH_REQUEST_TIMEOUT_MS: "500",
      },
      stderr: "pipe",
    });
    client = new Client({ name: "process-reconnect-test", version: "1.0.0" });
    await client.connect(transport);

    const initial = await eventually(async () => {
      const status = toolJson(await client!.callTool({ name: "dsh_status", arguments: { taskId: task.taskId } }));
      return status.availability === "connected" && status.finalMessage === "survived host restart" ? status : undefined;
    });
    assert.equal(initial.execution, "turn_completed");

    await firstHost.close();
    firstHost = undefined;
    await eventually(async () => {
      const status = toolJson(await client!.callTool({ name: "dsh_host_status", arguments: {} }));
      return status.availability === "host_unreachable" ? status : undefined;
    });

    secondHost = await startMockDshHost({ port });
    installDurableHostState(secondHost);
    const recovered = await eventually(async () => {
      const status = toolJson(await client!.callTool({ name: "dsh_status", arguments: { taskId: task.taskId } }));
      return status.availability === "connected" && status.finalMessage === "survived host restart" ? status : undefined;
    });
    assert.deepEqual(recovered.finalMessagePointer, { sessionId: "durable-session", seq: 1 });
    assert.equal((recovered.connection as Record<string, unknown>).connectionEpoch, 2);
  } finally {
    await client?.close().catch(() => undefined);
    await firstHost?.close().catch(() => undefined);
    await secondHost?.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
});
