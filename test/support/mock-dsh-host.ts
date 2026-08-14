import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

import { WebSocketServer, type WebSocket } from "ws";

type JsonObject = Record<string, unknown>;

export interface RecordedUnaryRequest {
  path: string;
  method: string;
  rpcId: string;
  payload: unknown;
  body: unknown;
}

export interface RecordedResponseRequest {
  path: string;
  body: unknown;
}

export interface MockDshHost {
  baseUrl: string;
  requests: RecordedUnaryRequest[];
  responses: RecordedResponseRequest[];
  muxConnections: string[];
  timeline: string[];
  setUnaryHandler(method: string, handler: (payload: unknown, request: RecordedUnaryRequest) => unknown): void;
  setRawUnaryHandler(method: string, handler: (request: RecordedUnaryRequest, response: ServerResponse) => Promise<void> | void): void;
  setRespondHandler(handler: (body: unknown) => unknown): void;
  setMuxBaseline(frames: JsonObject[]): void;
  sendMux(payload: JsonObject, options?: { rpcId?: string; method?: string }): void;
  closeMux(code?: number, reason?: string): void;
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

function writeJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function fail(response: ServerResponse, message: string) {
  writeJson(response, 400, { error: message });
}

export async function startMockDshHost(options: { port?: number } = {}): Promise<MockDshHost> {
  const requests: RecordedUnaryRequest[] = [];
  const responses: RecordedResponseRequest[] = [];
  const unaryHandlers = new Map<string, (payload: unknown, request: RecordedUnaryRequest) => unknown>();
  const rawUnaryHandlers = new Map<string, (request: RecordedUnaryRequest, response: ServerResponse) => Promise<void> | void>();
  const muxConnections: string[] = [];
  const timeline: string[] = [];
  const sockets = new Set<WebSocket>();
  let respondHandler: (body: unknown) => unknown = () => ({ accepted: true });
  let muxBaseline: JsonObject[] = [];

  const server: Server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST") {
        fail(response, "expected POST");
        return;
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const body = await readJson(request);

      if (url.pathname === "/api/respond") {
        responses.push({ path: url.pathname, body });
        if (!isObject(body) || body.type !== "client-response" || typeof body.rpcId !== "string") {
          fail(response, "invalid client-response");
          return;
        }
        writeJson(response, 200, respondHandler(body));
        return;
      }

      const prefix = "/api/";
      if (!url.pathname.startsWith(prefix)) {
        fail(response, "invalid path");
        return;
      }

      const method = decodeURIComponent(url.pathname.slice(prefix.length));
      if (!isObject(body) || body.type !== "client-request" || body.method !== method || typeof body.rpcId !== "string") {
        fail(response, "invalid client-request");
        return;
      }

      const recorded: RecordedUnaryRequest = {
        path: url.pathname,
        method,
        rpcId: body.rpcId,
        payload: body.payload,
        body,
      };
      requests.push(recorded);
      timeline.push(`http:${method}`);

      const rawHandler = rawUnaryHandlers.get(method);
      if (rawHandler !== undefined) {
        await rawHandler(recorded, response);
        return;
      }

      const handler = unaryHandlers.get(method);
      if (handler === undefined) {
        writeJson(response, 404, { error: `unknown method ${method}` });
        return;
      }

      writeJson(response, 200, {
        type: "server-response",
        rpcId: recorded.rpcId,
        result: { ok: true, value: handler(recorded.payload, recorded) },
      });
    } catch (error) {
      writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (socket, request) => {
    muxConnections.push(request.url ?? "");
    timeline.push("mux:open");
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    for (const [index, payload] of muxBaseline.entries()) {
      socket.send(
        JSON.stringify({
          type: "server-request",
          rpcId: `baseline-${muxConnections.length}-${index}`,
          method: payload.type,
          payload,
        }),
      );
    }
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

  server.listen(options.port ?? 0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!isObject(address) || typeof address.port !== "number") {
    throw new Error("mock DSH Host did not bind a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    responses,
    muxConnections,
    timeline,
    setUnaryHandler(method, handler) {
      unaryHandlers.set(method, handler);
    },
    setRawUnaryHandler(method, handler) {
      rawUnaryHandlers.set(method, handler);
    },
    setRespondHandler(handler) {
      respondHandler = handler;
    },
    setMuxBaseline(frames) {
      muxBaseline = structuredClone(frames);
    },
    sendMux(payload, options = {}) {
      const message = JSON.stringify({
        type: "server-request",
        rpcId: options.rpcId ?? `rpc-${requests.length + responses.length + muxConnections.length}`,
        method: options.method ?? payload.type,
        payload,
      });
      for (const socket of sockets) {
        socket.send(message);
      }
    },
    closeMux(code = 1000, reason = "done") {
      for (const socket of sockets) {
        socket.close(code, reason);
      }
    },
    async close() {
      for (const socket of sockets) {
        socket.close();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}
