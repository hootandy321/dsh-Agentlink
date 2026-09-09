import assert from "node:assert/strict";
import { test } from "node:test";

import { WebSocket } from "ws";

import { DshClient, DshRpcError, DshTransportError } from "../src/dsh-client.js";
import { dshUnaryMetadata, getDshUnaryMetadata, type DshClientResponse } from "../src/dsh-types.js";
import { startMockDshHost } from "./support/mock-dsh-host.js";

function clientFor(baseUrl: string): DshClient {
  return new DshClient(baseUrl, 1_000, globalThis.fetch, (url) => new WebSocket(url) as unknown as globalThis.WebSocket);
}

test("sends unary client-request envelope and accepts matching server-response rpcId", async () => {
  const host = await startMockDshHost();
  try {
    host.setUnaryHandler("host.describe", () => ({
      version: "0.1.0-rc.6",
      cwd: "/tmp/project",
      attachedSessions: 1,
      canOpenPath: true,
    }));

    const description = await clientFor(host.baseUrl).hostDescribe();

    assert.equal(description.version, "0.1.0-rc.6");
    assert.equal(host.requests.length, 1);
    assert.equal(host.requests[0]?.path, "/api/host.describe");
    assert.equal(host.requests[0]?.method, "host.describe");
    assert.deepEqual(host.requests[0]?.payload, {});
    assert.equal((host.requests[0]?.body as { type?: unknown }).type, "client-request");
    assert.equal((host.requests[0]?.body as { method?: unknown }).method, "host.describe");
    assert.equal(typeof host.requests[0]?.rpcId, "string");
    assert.notEqual(host.requests[0]?.rpcId, "");
    assert.equal(getDshUnaryMetadata(description).issuedRpcId, host.requests[0]?.rpcId);
    assert.equal(getDshUnaryMetadata(description).method, "host.describe");
    assert.equal(Object.prototype.propertyIsEnumerable.call(description, dshUnaryMetadata), false);
  } finally {
    await host.close();
  }
});

test("session.prompt returns Host value with the issued bridge rpcId metadata", async () => {
  const host = await startMockDshHost();
  try {
    host.setUnaryHandler("session.prompt", () => ({ accepted: true }));

    const receipt = await clientFor(host.baseUrl).sessionPrompt({
      sessionId: "session-1",
      mode: "queue",
      content: [{ type: "text", text: "hello" }],
    });

    assert.deepEqual(receipt, { accepted: true });
    assert.equal(getDshUnaryMetadata(receipt).issuedRpcId, host.requests[0]?.rpcId);
    assert.equal(getDshUnaryMetadata(receipt).method, "session.prompt");
    assert.deepEqual(JSON.parse(JSON.stringify(receipt)), { accepted: true });
  } finally {
    await host.close();
  }
});

test("rejects a unary response with a mismatched rpcId", async () => {
  const host = await startMockDshHost();
  try {
    host.setRawUnaryHandler("host.describe", (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "server-response",
          rpcId: "different-rpc",
          result: {
            ok: true,
            value: { version: "0.1.0-rc.6", cwd: "/tmp/project", attachedSessions: 0, canOpenPath: true },
          },
        }),
      );
    });

    await assert.rejects(() => clientFor(host.baseUrl).hostDescribe(), DshTransportError);
  } finally {
    await host.close();
  }
});

test("posts client-response directly to /api/respond and returns receipt", async () => {
  const host = await startMockDshHost();
  try {
    const message: DshClientResponse = {
      type: "client-response",
      rpcId: "question-rpc",
      result: {
        ok: true,
        value: {
          sessionId: "session-1",
          answer: { answers: [{ id: "q1", selected: ["yes"] }] },
        },
      },
    };

    const receipt = await clientFor(host.baseUrl).respond(message);

    assert.deepEqual(receipt, { accepted: true });
    assert.equal(host.responses.length, 1);
    assert.equal(host.responses[0]?.path, "/api/respond");
    assert.deepEqual(host.responses[0]?.body, message);
    assert.equal(host.requests.length, 0);
  } finally {
    await host.close();
  }
});

test("rejects an unknown unary method as a transport error", async () => {
  const host = await startMockDshHost();
  try {
    await assert.rejects(() => clientFor(host.baseUrl).sessionCancel("session-1"), DshTransportError);
  } finally {
    await host.close();
  }
});

test("opens events.mux over websocket and requires method to match payload type", async () => {
  const host = await startMockDshHost();
  const controller = new AbortController();
  try {
    const iterator = clientFor(host.baseUrl).openMux(controller.signal, () => {
      host.sendMux({
        type: "session/subscribed",
        sessionId: "session-1",
        lastSeq: 7,
      });
    })[Symbol.asyncIterator]();

    const next = await iterator.next();

    assert.equal(next.done, false);
    assert.equal(next.value.method, "session/subscribed");
    assert.equal(next.value.payload.type, "session/subscribed");
    assert.equal(next.value.payload.sessionId, "session-1");
    assert.deepEqual(host.muxConnections, ["/api/events.mux"]);
  } finally {
    controller.abort();
    await host.close();
  }
});

test("throws when events.mux method does not match payload type", async () => {
  const host = await startMockDshHost();
  const controller = new AbortController();
  try {
    const iterator = clientFor(host.baseUrl).openMux(controller.signal, () => {
      host.sendMux(
        {
          type: "session/subscribed",
          sessionId: "session-1",
          lastSeq: 7,
        },
        { method: "session/event" },
      );
    })[Symbol.asyncIterator]();

    await assert.rejects(() => iterator.next(), DshTransportError);
  } finally {
    controller.abort();
    await host.close();
  }
});

test("throws DshRpcError when events.mux sends stream error", async () => {
  const host = await startMockDshHost();
  const controller = new AbortController();
  try {
    const iterator = clientFor(host.baseUrl).openMux(controller.signal, () => {
      host.sendMux({
        type: "stream/error",
        error: { code: "boom", message: "stream failed", details: { retry: false } },
      });
    })[Symbol.asyncIterator]();

    await assert.rejects(
      () => iterator.next(),
      (error: unknown) => error instanceof DshRpcError && error.code === "boom" && error.message === "stream failed",
    );
  } finally {
    controller.abort();
    await host.close();
  }
});

test("calls session.updateQueue with the expected client-request payload", async () => {
  const host = await startMockDshHost();
  try {
    host.setUnaryHandler("session.updateQueue", () => ({ accepted: true }));

    const receipt = await clientFor(host.baseUrl).sessionUpdateQueue("session-1", "queue-item-1", { kind: "remove" });

    assert.deepEqual(receipt, { accepted: true });
    assert.equal(host.requests[0]?.method, "session.updateQueue");
    assert.deepEqual(host.requests[0]?.payload, {
      sessionId: "session-1",
      itemId: "queue-item-1",
      action: { kind: "remove" },
    });
  } finally {
    await host.close();
  }
});

test("calls subagent.list and parses entries", async () => {
  const host = await startMockDshHost();
  try {
    host.setUnaryHandler("subagent.list", () => ({
      parentAvailable: true,
      entries: [
        { kind: "child", id: "child-1", mode: "continuable", label: "worker", activity: "running", hasChildren: false },
        { kind: "diagnostic", id: "bad-child", reason: "corrupt" },
      ],
    }));

    const result = await clientFor(host.baseUrl).subagentList("parent-1");

    assert.equal(host.requests[0]?.method, "subagent.list");
    assert.deepEqual(host.requests[0]?.payload, { parentSessionId: "parent-1" });
    assert.equal(result.parentAvailable, true);
    assert.equal(result.entries.length, 2);
  } finally {
    await host.close();
  }
});

test("calls subagent.history with address and history options", async () => {
  const host = await startMockDshHost();
  try {
    host.setUnaryHandler("subagent.history", () => ({
      hasMore: false,
      events: [
        {
          event: {
            type: "assistant/message",
            seq: 3,
            time: 1_723_000_000,
            data: { message: { content: [{ type: "text", text: "done" }] } },
          },
        },
      ],
    }));

    const history = await clientFor(host.baseUrl).subagentHistory(
      { parentSessionId: "parent-1", childSessionId: "child-1", mode: "continuable" },
      { beforeSeq: 10, maxMessages: 5 },
    );

    assert.equal(host.requests[0]?.method, "subagent.history");
    assert.deepEqual(host.requests[0]?.payload, {
      parentSessionId: "parent-1",
      childSessionId: "child-1",
      mode: "continuable",
      beforeSeq: 10,
      maxMessages: 5,
    });
    assert.equal(history.events[0]?.event.seq, 3);
  } finally {
    await host.close();
  }
});

test("calls agentPreset.list with empty payload and parses presets", async () => {
  const host = await startMockDshHost();
  try {
    host.setUnaryHandler("agentPreset.list", () => ({
      presets: [
        { id: "preset-1", trust: "system", isDefault: true, name: "Default" },
        { id: "preset-2", trust: "user", isDefault: false, name: "Mine", description: "custom" },
      ],
      authorable: true,
      hasDocument: false,
    }));

    const result = await clientFor(host.baseUrl).agentPresetList();

    assert.equal(host.requests[0]?.method, "agentPreset.list");
    assert.deepEqual(host.requests[0]?.payload, {});
    assert.equal(result.presets.length, 2);
    assert.equal(result.presets[0]?.id, "preset-1");
    assert.equal(result.presets[0]?.trust, "system");
    assert.equal(result.presets[0]?.isDefault, true);
    assert.equal(result.presets[1]?.trust, "user");
    assert.equal(result.presets[1]?.name, "Mine");
    assert.equal(result.presets[1]?.description, "custom");
    assert.equal(result.authorable, true);
    assert.equal(result.hasDocument, false);
  } finally {
    await host.close();
  }
});

test("rejects an agentPreset.list preset with malformed trust", async () => {
  const host = await startMockDshHost();
  try {
    host.setUnaryHandler("agentPreset.list", () => ({
      presets: [{ id: "preset-1", trust: "admin", isDefault: false }],
      authorable: true,
      hasDocument: false,
    }));

    await assert.rejects(() => clientFor(host.baseUrl).agentPresetList(), DshTransportError);
  } finally {
    await host.close();
  }
});

test("rejects an agentPreset.list preset with empty broken string", async () => {
  const host = await startMockDshHost();
  try {
    host.setUnaryHandler("agentPreset.list", () => ({
      presets: [{ id: "preset-1", trust: "user", isDefault: false, broken: "" }],
      authorable: true,
      hasDocument: false,
    }));

    await assert.rejects(() => clientFor(host.baseUrl).agentPresetList(), DshTransportError);
  } finally {
    await host.close();
  }
});
