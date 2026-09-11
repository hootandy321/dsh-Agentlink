import test from "node:test";
import assert from "node:assert/strict";

test("client registers a session-scoped DSH 0.1.5 sidebar tab and disposes its registrations", async () => {
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
  const openedTabs: string[] = [];
  const effects: Array<() => void> = [];
  let tabDefinition: any;
  let tabComponent: any;
  let disposed = 0;
  let openedSession: string | undefined;
  let openedAddress: unknown;

  const ctx = {
    remote: { agentlink: {} },
    sessions: {
      open: (sessionId: string) => { openedSession = sessionId; },
      openSubagent: (address: unknown) => { openedAddress = address; }
    },
    sidebarRight: { openTab: (kind: string) => { openedTabs.push(kind); } },
    sidebarRightTabs: { register: (definition: any) => { tabDefinition = definition; return () => { disposed++; }; } },
    effect: (fn: () => any) => { effects.push(fn()); },
    slots: {
      inject: (name: string, fn: () => () => void) => {
        injectors.set(name, fn);
        return () => { disposed++; };
      },
      register: (options: any, component: any) => {
        if (options.name === "sidebar.right.pane.tab") tabComponent = component;
        registrations.push(options);
        return () => { disposed++; };
      }
    }
  };

  mod.apply(ctx);
  const disposeBody = injectors.get("sidebar.right.pane.tab")!();
  const disposeHeader = injectors.get("conversation.session.header.actions")!();
  const header = registrations.find((entry) => (entry as { id?: string }).id === "dsh-agentlink") as {
    inject: (sessionId: string) => { openAgentlink: () => void };
  };
  header.inject("session-root").openAgentlink();
  const details = registrations.find((entry) => (entry as { name?: string }).name === "sidebar.right.pane.tab") as {
    inject: (sessionId: string) => { sessionId: string; openSession: (session: {sessionId: string; subagentAddress?: unknown}) => void; remote: { agentlink: { summary: (input: unknown) => Promise<unknown>; prices: () => Promise<unknown> } } };
  };
  details.inject("session-root").openSession({sessionId: "session-root"});
  const address = {parentSessionId:"session-root",childSessionId:"child",mode:"one-shot"};
  details.inject("session-root").openSession({sessionId: "child", subagentAddress:address});
  assert.deepEqual(openedAddress,address);

  assert.deepEqual(mod.inject, ["slots", "sidebarRight", "sidebarRightTabs", "sessions"]);
  assert.deepEqual(openedTabs, ["agentlink"]);
  assert.equal(tabDefinition.id, "dsh-agentlink-dsh-plugin");
  assert.equal(tabDefinition.kind, "agentlink");
  assert.equal(openedSession, "session-root");
  assert.equal(details.inject("another-session").sessionId, "another-session");
  // A tab closes through its own bound actions, even after the active session changes.
  const tabActions: string[] = [];
  const rendered = tabComponent({ ...details.inject("session-root"), useTabInfo: () => ({ tab: { actions: {
    close: () => tabActions.push("close-root-tab"), openTab: (kind: string) => tabActions.push(kind),
  } } }) });
  const buttons: any[] = [];
  function visit(node: any): void {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node?.element) return;
    if (node.element[0] === "button") buttons.push(node.element);
    node.element.slice(2).forEach(visit);
  }
  visit(rendered);
  buttons.find(button => button[2] === "关闭")[1].onClick();
  buttons.find(button => button[2] === "右栏首页")[1].onClick();
  assert.deepEqual(tabActions, ["close-root-tab", "guide"]);
  const originalFetch = globalThis.fetch;
  const requests: { url: string; body: any }[] = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push({ url: String(url), body });
    assert.equal(init?.credentials, "same-origin");
    return new Response(JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value: { visible: true } } }));
  };
  try {
    const remote = details.inject("session-root").remote;
    assert.deepEqual(await remote.agentlink.summary({ sessionId: "session-root" }), { visible: true });
    await remote.agentlink.prices();
    assert.equal(requests[0]?.url, "/api/agentlink/summary");
    assert.deepEqual(requests[0]?.body.payload.args, { input: { sessionId: "session-root" } });
    assert.deepEqual(requests[1]?.body.payload.args, {});
    globalThis.fetch = async () => new Response(JSON.stringify({ rpcId: "wrong", result: { ok: true, value: {} } }));
    await assert.rejects(remote.agentlink.summary({}), /response id mismatch/);
  } finally { globalThis.fetch = originalFetch; }
  disposeBody(); disposeHeader(); effects.reverse().forEach(dispose => dispose());
  assert.equal(disposed, 5);
  assert.ok(registrations.some((entry) => (entry as { name?: string }).name === "sidebar.right.pane.tab"));
});

test("packed client executes as the classic script required by the official DSH loader", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  let id: string | undefined;
  runInNewContext(source, { window: { __ModuleLoader__: { load: (entry: { id: string }) => { id = entry.id; } } } });
  assert.equal(id, "dsh-agentlink-dsh-plugin");
});
