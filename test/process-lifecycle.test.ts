import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { WebSocketServer, type WebSocket } from "ws";

import { TaskStore } from "../src/task-store.js";

type JsonObject = Record<string, unknown>;

interface LifecycleHost {
  baseUrl: string;
  muxOpenCount: number;
  muxCloseCount: number;
  requests: string[];
  responses: unknown[];
  waitForMuxOpen(): Promise<void>;
  sendMux(payload: JsonObject): void;
  close(): Promise<void>;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : JSON.parse(text);
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function hostResponse(rpcId: string, value: unknown): JsonObject {
  return { type: "server-response", rpcId, result: { ok: true, value } };
}

function event(seq: number, type: string, data: unknown): JsonObject {
  return { type, seq, time: 1000 + seq, data };
}

function ledgerPath(home: string, taskId: string): string {
  return join(home, "ledgers", taskId, "events.jsonl");
}

async function startLifecycleHost(sessionId: string): Promise<LifecycleHost> {
  const requests: string[] = [];
  const responses: unknown[] = [];
  const sockets = new Set<WebSocket>();
  const muxWaiters: Array<() => void> = [];
  let muxOpenCount = 0;
  let muxCloseCount = 0;

  const server: Server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST") {
        writeJson(response, 400, { error: "expected POST" });
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const body = await readJson(request);

      if (url.pathname === "/api/respond") {
        responses.push(body);
        writeJson(response, 200, { accepted: true });
        return;
      }

      if (!url.pathname.startsWith("/api/") || !isObject(body) || body.type !== "client-request") {
        writeJson(response, 400, { error: "invalid request" });
        return;
      }

      const method = String(body.method);
      const rpcId = String(body.rpcId);
      requests.push(method);
      if (method === "host.describe") {
        writeJson(response, 200, hostResponse(rpcId, { version: "0.0.1", cwd: "/tmp", attachedSessions: 1, canOpenPath: true }));
        return;
      }
      if (method === "session.list") {
        writeJson(response, 200, hostResponse(rpcId, { items: [{ sessionId, updatedAt: 1, running: true, blank: false }] }));
        return;
      }
      if (method === "session.history") {
        writeJson(response, 200, hostResponse(rpcId, {
          events: [
            { event: event(0, "turn/start", { turn: 1 }) },
            { event: event(1, "assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "before eof" }] } }) },
          ],
          hasMore: false,
        }));
        return;
      }
      if (method === "session.models") {
        writeJson(response, 200, hostResponse(rpcId, { current: { provider: "deepseek-official", model: "deepseek-v4-flash" }, routable: true, groups: [], failures: [] }));
        return;
      }

      writeJson(response, 404, { error: `unexpected method ${method}` });
    } catch (error) {
      writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (socket) => {
    muxOpenCount += 1;
    sockets.add(socket);
    socket.once("close", () => {
      muxCloseCount += 1;
      sockets.delete(socket);
    });
    while (muxWaiters.length > 0) muxWaiters.shift()?.();
    socket.send(JSON.stringify({
      type: "server-request",
      rpcId: "subscribed-1",
      method: "session/subscribed",
      payload: { type: "session/subscribed", sessionId, lastSeq: 1 },
    }));
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/api/events.mux") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit("connection", webSocket, request);
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!isObject(address) || typeof address.port !== "number") throw new Error("mock Host did not bind a TCP port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get muxOpenCount() {
      return muxOpenCount;
    },
    get muxCloseCount() {
      return muxCloseCount;
    },
    requests,
    responses,
    waitForMuxOpen() {
      if (muxOpenCount > 0) return Promise.resolve();
      return new Promise<void>((resolve) => muxWaiters.push(resolve));
    },
    sendMux(payload) {
      const message = JSON.stringify({
        type: "server-request",
        rpcId: `event-${String(payload.type)}-${Date.now()}`,
        method: payload.type,
        payload,
      });
      for (const socket of sockets) socket.send(message);
    },
    async close() {
      for (const socket of sockets) socket.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

async function eventually(operation: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await operation()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition was not met before timeout");
}

async function childExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not exit before timeout")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test("bridge process exits cleanly when MCP stdin reaches EOF", { timeout: 10_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-process-lifecycle-"));
  const sessionId = "lifecycle-session";
  let host: LifecycleHost | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    host = await startLifecycleHost(sessionId);
    const task = await new TaskStore(home).create(sessionId);
    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    child = spawn(process.execPath, ["dist/index.js"], {
      cwd: process.cwd(),
      env: {
        ...inheritedEnv,
        DSH_HOST_URL: host.baseUrl,
        DSH_BRIDGE_HOME: home,
        DSH_REQUEST_TIMEOUT_MS: "500",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    await host.waitForMuxOpen();
    await eventually(async () => {
      const log = await readFile(ledgerPath(home, task.taskId), "utf8").catch(() => "");
      return log.includes("assistant/message");
    });
    const logBeforeEof = await readFile(ledgerPath(home, task.taskId), "utf8");

    const exitPromise = childExit(child, 2_000);
    child.stdin.end();
    const exit = await exitPromise;
    child = undefined;

    assert.deepEqual(exit, { code: 0, signal: null }, stderr);
    await eventually(() => host!.muxCloseCount === 1);
    assert.equal(host.muxOpenCount, 1);
    assert.equal(host.requests.includes("session.cancel"), false);
    assert.equal(host.responses.length, 0);

    host.sendMux({ type: "session/event", sessionId, event: event(2, "turn/end", { turn: 1, reason: { kind: "completed" } }) });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const logAfterEof = await readFile(ledgerPath(home, task.taskId), "utf8");
    assert.equal(logAfterEof, logBeforeEof);
  } finally {
    if (child !== undefined) child.kill("SIGKILL");
    await host?.close().catch(() => undefined);
    await mkdir(home, { recursive: true }).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
});
