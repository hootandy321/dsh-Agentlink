import test from "node:test";
import assert from "node:assert/strict";

test("client registers the header action and lazy details panel", async () => {
  let loaded: { id: string; factory: (require: (id: string) => unknown) => unknown } | undefined;
  (globalThis as unknown as { window: unknown }).window = {
    __ModuleLoader__: {
      load(input: typeof loaded) {
        loaded = input;
      }
    }
  };

  await import(`../src/client.ts?case=${Date.now()}`);
  const mod = loaded?.factory((id) => {
    if (id !== "react") throw new Error(`unexpected require: ${id}`);
    return {
      createElement: (...args: unknown[]) => ({ element: args }),
      Fragment: Symbol("Fragment"),
      useState: (initial: unknown) => [initial, () => undefined],
      useEffect: () => undefined
    };
  }) as { apply(ctx: unknown): void; inject: string[] };

  const registrations: unknown[] = [];
  const injectors = new Map<string, () => () => void>();
  let detailsOpened = 0;
  let openedSession: string | undefined;
  let openedAddress: unknown;
  let selection = "session-root";
  let selectionChanged = () => {};
  let detailsDisposed = 0;
  const ctx = {
    remote: { agentlink: {} },
    sessions: {
      list: { getSnapshot: () => ({ current: selection }), subscribe: (fn: () => void) => { selectionChanged = fn; return () => {}; } },
      open: (sessionId: string) => { openedSession = sessionId; },
      openSubagent: (address: unknown) => { openedAddress = address; }
    },
    layout: {
      openDetails: () => { detailsOpened += 1; },
      closeDetails: () => undefined
    },
    effect: (fn: () => unknown) => fn(),
    slots: {
      inject: (name: string, fn: () => () => void) => {
        injectors.set(name, fn);
        return () => undefined;
      },
      register: (options: unknown) => {
        registrations.push(options);
        return () => { if ((options as {name:string}).name === "details") detailsDisposed += 1; };
      }
    }
  };

  mod.apply(ctx);
  injectors.get("details")?.();
  injectors.get("conversation.session.header.actions")?.();
  const header = registrations.find((entry) => (entry as { id?: string }).id === "dsh-agentlink") as {
    inject: (sessionId: string) => { openAgentlink: () => void };
  };
  header.inject("session-root").openAgentlink();
  const details = registrations.find((entry) => (entry as { name?: string }).name === "details") as {
    inject: () => { openSession: (session: {sessionId: string; subagentAddress?: unknown}) => void; nativeDetails: () => void; remote: { agentlink: { summary: (input: unknown) => Promise<unknown>; prices: () => Promise<unknown> } } };
  };
  details.inject().openSession({sessionId: "session-root"});
  const address = {parentSessionId:"session-root",childSessionId:"child",mode:"one-shot"};
  details.inject().openSession({sessionId: "child", subagentAddress:address});
  assert.deepEqual(openedAddress,address);

  assert.deepEqual(mod.inject, ["slots", "layout", "sessions"]);
  assert.equal(detailsOpened, 1);
  assert.equal(openedSession, "session-root");
  details.inject().nativeDetails();
  assert.equal(detailsDisposed, 1);
  header.inject("session-root").openAgentlink();
  selection = "another-session"; selectionChanged();
  assert.equal(detailsDisposed, 2);
  const originalFetch = globalThis.fetch;
  const requests: { url: string; body: any }[] = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push({ url: String(url), body });
    assert.equal(init?.credentials, "same-origin");
    return new Response(JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value: { visible: true } } }));
  };
  try {
    const remote = details.inject().remote;
    assert.deepEqual(await remote.agentlink.summary({ sessionId: "session-root" }), { visible: true });
    await remote.agentlink.prices();
    assert.equal(requests[0]?.url, "/api/agentlink/summary");
    assert.deepEqual(requests[0]?.body.payload.args, { input: { sessionId: "session-root" } });
    assert.deepEqual(requests[1]?.body.payload.args, {});
    globalThis.fetch = async () => new Response(JSON.stringify({ rpcId: "wrong", result: { ok: true, value: {} } }));
    await assert.rejects(remote.agentlink.summary({}), /response id mismatch/);
  } finally { globalThis.fetch = originalFetch; }
  assert.ok(registrations.some((entry) => (entry as { name?: string }).name === "details"));
});

test("packed client executes as the classic script required by the official DSH loader", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  let id: string | undefined;
  runInNewContext(source, { window: { __ModuleLoader__: { load: (entry: { id: string }) => { id = entry.id; } } } });
  assert.equal(id, "dsh-agentlink-dsh-plugin");
});
