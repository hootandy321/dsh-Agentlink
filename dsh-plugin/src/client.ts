interface AgentlinkWindow extends Window {
  __ModuleLoader__?: { load(input: { id: string; factory: (require: (id: string) => unknown) => unknown }): void };
};

(window as AgentlinkWindow).__ModuleLoader__?.load({
  id: "dsh-agentlink-dsh-plugin",
  factory: (require) => {
    const React = require("react") as any;
    const h = React.createElement;
    const sourceName = (client: string) => client === "codex" ? "Codex 调用" : (client === "claude-code" || client === "claude") ? "Claude 调用" : `${client || "其他"} 调用`;
    const money = (value: any, absolute = false): string => {
      if (typeof value?.picoUsd !== "string") return "待估算";
      let pico = BigInt(value.picoUsd);
      if (absolute && pico < 0n) pico = -pico;
      const negative = pico < 0n, abs = negative ? -pico : pico;
      if (abs > 0n && abs < 100000000n) return `${negative ? "−" : ""}<$0.0001`;
      const whole = abs / 1000000000000n;
      const fraction = (abs % 1000000000000n).toString().padStart(12, "0").slice(0, whole > 0n ? 4 : 6);
      return `${negative ? "−" : ""}$${whole}.${fraction}`;
    };
    const css = `
      .agentlink-panel { --al-bg:#f6f7fa; --al-card:#fff; --al-text:#182230; --al-muted:#667085; --al-line:#dfe3eb; box-sizing:border-box; height:100%; overflow:auto; padding:16px; background:var(--al-bg); color:var(--al-text); font:13px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif; }
      body[data-ds-dark-theme] .agentlink-panel { --al-bg:#191b21; --al-card:#23262e; --al-text:#ecedf1; --al-muted:#a5adbc; --al-line:#363b48; }
      .agentlink-panel * { box-sizing:border-box; }
      .agentlink-btn,.agentlink-tab { cursor:pointer; font:inherit; color:inherit; background:transparent; border:1px solid var(--al-line,#cdd2dc); border-radius:6px; padding:5px 9px; }
      .agentlink-btn:hover,.agentlink-tab:hover { border-color:#6380dd; }
      .agentlink-head { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:14px; }
      .agentlink-title { font-size:15px; font-weight:650; }
      .agentlink-tabs { display:flex; gap:6px; margin:0 0 14px; }
      .agentlink-tab[data-active=true] { background:#4263cf; border-color:#4263cf; color:white; }
      .agentlink-card { background:var(--al-card); border:1px solid var(--al-line); padding:12px; border-radius:9px; margin-bottom:10px; }
      .agentlink-card h3 { font-size:12px; font-weight:500; margin:0 0 6px; color:var(--al-muted); }
      .agentlink-saving { font-size:21px; font-weight:650; font-variant-numeric:tabular-nums; letter-spacing:-.4px; }
      .agentlink-saving[data-negative=true] { color:#d15b48; }
      .agentlink-meta { color:var(--al-muted); font-size:11px; margin-top:7px; overflow-wrap:anywhere; }
      .agentlink-metrics { margin:10px 0 0; font-size:11px; }
      .agentlink-metrics div { display:flex; justify-content:space-between; gap:8px; margin:3px 0; }
      .agentlink-metrics dt { color:var(--al-muted); } .agentlink-metrics dd { margin:0; font-variant-numeric:tabular-nums; }
      .agentlink-note { color:var(--al-muted); font-size:11px; margin:12px 0; }
      .agentlink-warning { border-left:3px solid #ba893c; padding:7px 10px; background:var(--al-card); margin:8px 0; font-size:12px; }
      .agentlink-group h3 { font-size:12px; margin:14px 0 7px; }
      .agentlink-run { border:1px solid var(--al-line); background:var(--al-card); border-radius:7px; margin:7px 0; padding:8px 10px; overflow-wrap:anywhere; }
      .agentlink-run summary { cursor:pointer; } .agentlink-run button { display:block; text-align:left; margin:7px 0; width:100%; overflow-wrap:anywhere; }
      .agentlink-panel details>summary { cursor:pointer; } .agentlink-row { margin:9px 0; padding-bottom:9px; border-bottom:1px solid var(--al-line); overflow-wrap:anywhere; }
    `;

    function useRemoteData(remote: any, sessionId: string | undefined, tab: string) {
      const [summary, setSummary] = React.useState(null), [runs, setRuns] = React.useState([]), [error, setError] = React.useState(null);
      React.useEffect(() => {
        let alive = true, busy = false;
        setSummary(null); setError(null);
        async function load() {
          if (busy) return; busy = true;
          try {
            if (tab === "cost") {
              const value = await remote.agentlink.summary(sessionId ? { sessionId } : {});
              if (alive) setSummary(value);
            } else {
              const value = await remote.agentlink.listRuns({ limit: 100 });
              if (alive) setRuns(value);
            }
            if (alive) setError(null);
          } catch (error) { if (alive) setError(String(error)); }
          finally { busy = false; }
        }
        void load();
        const timer = setInterval(load, 5000);
        return () => { alive = false; clearInterval(timer); };
      }, [remote, sessionId, tab]);
      return { summary, runs, error };
    }

    function LazyDetails({ title, load, render }: any) {
      const [value, setValue] = React.useState(null), [error, setError] = React.useState(null);
      const alive = React.useRef(true), busy = React.useRef(false);
      React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
      return h("details", { className: "agentlink-row", onToggle: async (event: any) => {
        if (!event.currentTarget.open || busy.current) return;
        busy.current = true;
        try { const result = await load(); if (alive.current) { setValue(result); setError(null); } }
        catch (error) { if (alive.current) setError(String(error)); }
        finally { busy.current = false; }
      } }, h("summary", null, title), error ? h("p", { role: "alert" }, error) : value === null ? h("p", null, "读取中…") : render(value));
    }

    function CostView({ summary, remote, sessionId }: any) {
      if (summary === null) return h("p", { className: "agentlink-note" }, "读取用量统计…");
      const labels: Record<string, string> = {
        "non-agentlink-session": "当前 session 尚无 Agentlink 归属。",
        "collector-errors": "部分采集失败：统计可能不完整。",
        "storage-memory-fallback": "持久存储不可用：当前仅为内存统计，重启后不能保留。",
      };
      return h(React.Fragment, null,
        summary.notes.filter((note: string) => labels[note]).map((note: string) => h("div", { className: "agentlink-warning", key: note }, labels[note])),
        summary.items.map((item: any) => {
          const a = item.aggregate, negative = a.saving !== undefined && BigInt(a.saving.picoUsd) < 0n;
          const label = item.scope === "session" ? "本 session" : item.scope === "all" ? "插件累计 · 当前 Host" : item.label.replace("This task", "本次任务").replace(" sessions", " 个 session");
          const metric = (name: string, value: any) => h("div", { key: name }, h("dt", null, name), h("dd", null, money(value)));
          return h("section", { className: "agentlink-card", key: item.scope, "data-scope": item.scope },
            h("h3", null, label),
            h("div", { className: "agentlink-saving", "data-negative": negative }, a.saving === undefined ? "暂不可估算" : `${negative ? "预估增加" : "预估节省"} ${money(a.saving, true)}`),
            h("dl", { className: "agentlink-metrics" }, metric("DSH 已知用量计价", a.dshCostAllPriced), metric("其中可比较部分", a.dshCostComparable), metric("主模型同量估算", a.callerEquivalentCost)),
            h("p", { className: "agentlink-meta" }, `${a.comparableRequestCount} / ${a.requestCount} 笔请求可比较${a.partial ? " · 部分估算" : ""}`),
            Object.keys(a.coverage?.missingReasons ?? {}).length ? h("details", { className: "agentlink-meta" }, h("summary", null, "查看缺失原因"), Object.entries(a.coverage.missingReasons).map(([reason, count]) => h("div", { key: reason }, `${reason}：${count}`))) : null);
        }),
        h("p", { className: "agentlink-note" }, "同量 token、同缓存结构的 API 价格试算，不是订阅账单，也不预测主模型完成任务的实际用量。"),
        summary.caller?.model ? h("p", { className: "agentlink-note" }, `任务初始比较模型：${summary.caller.model.id} · ${summary.caller.model.serviceTier ?? "未声明层级"}。每次提交保留自己的模型。`) : null,
        h(LazyDetails, { key: `usage:${sessionId}`, title: "请求与模型明细（最近 50 笔）", load: () => remote.agentlink.details(summary.runId ? { runId: summary.runId, limit: 50 } : { sessionId, limit: 50 }), render: (rows: any[]) => rows.length === 0 ? h("p", null, "暂无请求") : rows.map(row => h("div", { className: "agentlink-meta agentlink-row", key: row.requestRecordId },
          `${row.provider} / ${row.model}`, h("br"), `${row.status} · ${row.origin}`, h("br"),
          row.usage ? `输入 ${row.usage.inputTokens} · 缓存读 ${row.usage.cacheReadTokens ?? 0} · 输出 ${row.usage.outputTokens}` : "用量尚未收到",
          row.caller?.model ? h(React.Fragment, null, h("br"), `对比 ${row.caller.model.id}`) : null)) }),
        h(LazyDetails, { title: "价目与来源（USD / 百万 token）", load: () => remote.agentlink.prices(), render: (rows: any[]) => rows.map(row => h("div", { className: "agentlink-meta agentlink-row", key: row.priceId },
          h("strong", null, `${row.provider} / ${row.model}`), h("br"), `输入 ${row.rates.inputUsdPerMillion} · 输出 ${row.rates.outputUsdPerMillion}`, h("br"),
          `核对 ${row.checkedAt.slice(0, 10)}${row.longContext ? " · 含长上下文价" : ""}${row.timeWindows ? " · 含峰谷时段价" : ""}`, h("br"),
          /^https?:\/\//.test(row.sourceUrl) ? h("a", { href: row.sourceUrl, target: "_blank", rel: "noreferrer" }, "价格来源") : row.sourceUrl)) }),
        h("p", { className: "agentlink-note" }, `更新 ${new Date(summary.generatedAt).toLocaleTimeString()}`));
    }

    function CallView({ runs, remote, openSession }: any) {
      if (runs.length === 0) return h("p", { className: "agentlink-note" }, "还没有 Agentlink 调用记录。");
      const groups = new Map<string, any[]>();
      for (const run of runs) { const key = run.caller.client; groups.set(key, [...(groups.get(key) ?? []), run]); }
      return h(React.Fragment, null, [...groups].map(([client, group]) => h("section", { className: "agentlink-group", key: client },
        h("h3", null, sourceName(client)), group.map(run => h("div", { className: "agentlink-run", key: run.runId }, h(LazyDetails, {
          title: `${run.title ?? run.runId} · ${run.sessionCount} 个 session`,
          load: () => remote.agentlink.sessions({ runId: run.runId }),
          render: (sessions: any[]) => sessions.map(session => h("button", { className: "agentlink-btn", type: "button", key: session.sessionId, disabled: session.origin === "dsh-internal" && !session.subagentAddress, onClick: () => openSession(session) },
            `${session.parentSessionId ? "↳ 子会话" : "根会话"} · ${session.sessionId}${session.origin === "dsh-internal" && !session.subagentAddress ? " · 地址暂不可用" : ""}`)),
        }))))));
    }

    function HeaderAction({ openAgentlink }: any) { return h("button", { type: "button", className: "agentlink-btn", onClick: openAgentlink }, "Agentlink"); }
    function AgentlinkDetails({ sessionId, remote, closePanel, nativeDetails, openSession }: any) {
      const [tab, setTab] = React.useState("cost");
      const { summary, runs, error } = useRemoteData(remote, sessionId, tab);
      return h("aside", { className: "agentlink-panel", "aria-label": "Agentlink 成本与调用" }, h("style", null, css),
        h("div", { className: "agentlink-head" }, h("span", { className: "agentlink-title" }, "Agentlink"), h("button", { type: "button", className: "agentlink-btn", onClick: closePanel }, "关闭")),
        h("div", { className: "agentlink-tabs" }, ["cost", "calls"].map(value => h("button", { type: "button", className: "agentlink-tab", "data-active": tab === value, key: value, onClick: () => setTab(value) }, value === "cost" ? "成本" : "调用")), h("button", { type: "button", className: "agentlink-btn", onClick: nativeDetails }, "原生详情")),
        error ? h("div", { className: "agentlink-warning", role: "alert" }, `数据暂不可用：${error}`) : null,
        tab === "cost" ? h(CostView, { summary, remote, sessionId }) : h(CallView, { runs, remote, openSession }));
    }

    // Third-party namespaces are not generated into the official client registry.
    // Use the same-origin public Remote HTTP carrier with its named-argument envelope.
    function createReader() {
      const read = async (method: string, input?: unknown) => {
        const rpcId = crypto.randomUUID();
        const endpoint = `agentlink/${method}`;
        const response = await fetch(`/api/${endpoint}`, {
          method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "client-request", rpcId, method: endpoint,
            payload: { args: input === undefined ? {} : { input } } }),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`DSH Remote HTTP ${response.status}`);
        const body = await response.json();
        if (body.rpcId !== rpcId) throw new Error("DSH Remote response id mismatch");
        if (body.result?.ok !== true) throw new Error(body.result?.error?.message ?? "DSH Remote response invalid");
        return body.result.value;
      };
      return { agentlink: {
        summary: (input: unknown) => read("summary", input), listRuns: (input: unknown) => read("listRuns", input),
        details: (input: unknown) => read("details", input), sessions: (input: unknown) => read("sessions", input),
        prices: () => read("prices"),
      } };
    }

    function apply(ctx: any) {
      const remote = createReader();
      let registerDetails: (() => void) | undefined, disposeDetails: (() => void) | undefined, openedFor: string | undefined;
      const release = () => { const dispose = disposeDetails; disposeDetails = undefined; openedFor = undefined; dispose?.(); };
      const closePanel = () => { release(); ctx.layout.closeDetails(); };
      const nativeDetails = () => { release(); ctx.layout.openDetails(); };
      const openAgentlink = (sessionId: string) => { openedFor = sessionId; registerDetails?.(); ctx.layout.openDetails(); };
      ctx.effect(() => ctx.slots.inject("details", () => {
        registerDetails = () => {
          disposeDetails ??= ctx.slots.register({ name: "details", priority: -100,
            inject: () => ({ remote, closePanel, nativeDetails, openSession: (session: any) => session.subagentAddress ? ctx.sessions.openSubagent(session.subagentAddress) : ctx.sessions.open(session.sessionId) }),
          }, AgentlinkDetails);
        };
        return () => { registerDetails = undefined; release(); };
      }), "agentlink details registration");
      ctx.effect(() => ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
        name: "conversation.session.header.actions", id: "dsh-agentlink", inject: (sessionId: string) => ({ openAgentlink: () => openAgentlink(sessionId) }),
      }, HeaderAction)), "agentlink header action");
      ctx.effect(() => ctx.sessions.list.subscribe(() => {
        if (openedFor !== undefined && ctx.sessions.list.getSnapshot().current !== openedFor) closePanel();
      }), "agentlink session navigation cleanup");
    }
    return { apply, inject: ["slots", "layout", "sessions"] };
  },
});
