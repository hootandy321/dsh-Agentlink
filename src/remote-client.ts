import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { z } from "zod";
import { DshRpcError, DshTransportError } from "./dsh-client.js";
import { attachDshUnaryMetadata, dshSessionEventSchema, dshSessionListValueSchema,
  dshSessionCreateValueSchema, dshSessionPromptValueSchema, dshSessionRenameValueSchema,
  dshSessionCancelValueSchema, dshSessionUpdateQueueValueSchema, dshMuxFrameSchema, dshSubagentListValueSchema,
  type DshApi, type DshClientResponse, type DshMuxFrame, type DshServerRequest,
  type DshSubagentAddress, type DshHistoryEntry, type DshUnaryResult, type DshHostDescription,
  type DshSessionModels, type DshSessionHistory, type DshSubagentListValue,
} from "./dsh-types.js";

const object = z.record(z.string(), z.unknown());
const reply = z.object({ rpcId: z.string(), result: z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) }),
]) });
const catalogSchema = z.object({ default: z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional() }),
  routableProviders: z.array(z.string()), groups: z.array(z.any()), failures: z.array(z.any()) });
const record = (value: unknown): Record<string, any> => object.parse(value);
const errorCode = (code: string) => ({ "session/not-found": "session-not-found", "session/queue-item-not-found": "queue-item-not-found" }[code] ?? code);

/** Expand compressed history positions without retaining streamed text. */
export function remoteHistoryEntries(records: unknown[]): DshHistoryEntry[] {
  return records.flatMap((value) => {
    const entry = record(value);
    if (entry.type === "event") return [{ event: dshSessionEventSchema.parse(entry.event) }];
    if (entry.type !== "chunks") throw new DshTransportError("unknown Remote history record");
    const event = record(entry.event), data = record(event.data);
    const parts = event.type === "chunkrow/tool-call-chunks" ? data.args : data.texts;
    if (!Array.isArray(parts) || !Array.isArray(data.dt) || parts.length !== data.dt.length) throw new DshTransportError("invalid compressed history range");
    return parts.map((_, index) => ({ event: dshSessionEventSchema.parse({ type: "assistant/chunk", seq: event.seq + index,
      time: event.time + data.dt[index], data: { omitted: "assistant_chunk" } }) }));
  });
}

/** DSH 0.1.2-rc.1 Remote transport. Keeps legacy coordination shapes internal. */
export class RemoteDshClient implements DshApi {
  private cookie: string | undefined;
  private authentication: Promise<void> | undefined;
  private socket: WebSocket | undefined;
  private addresses = new Map<string, Record<string, unknown>>();
  private streams = new Map<string, string>();
  private cancelledStreams = new Set<string>();
  private clientId: string | undefined;
  private roots = new Set<string>();
  private checkingEvents = new Map<string, { cancelled: boolean }>();
  private pending = new Map<string, { sessionId: string; kind: "question" | "approval"; approvalId?: string }>();
  private emit: ((frame: DshMuxFrame, id?: string) => void) | undefined;

  constructor(readonly baseUrl: string, private readonly timeoutMs = 30_000,
    private readonly launchToken?: string, private readonly fetchImpl: typeof fetch = fetch, hostCookie?: string) {
    if (hostCookie !== undefined && !/^[A-Za-z0-9_-]+=[A-Za-z0-9._~-]+$/.test(hostCookie)) throw new DshTransportError("invalid DSH_HOST_COOKIE format");
    this.cookie = hostCookie;
  }

  private async authenticate(signal?: AbortSignal) {
    if (this.cookie !== undefined || this.launchToken === undefined) return;
    this.authentication ??= (async () => {
      const url = new URL("/", this.baseUrl);
      url.searchParams.set("token", this.launchToken!);
      let response: Response;
      try { response = await this.fetchImpl(url, { redirect: "manual", signal: this.signal(signal) }); }
      catch { throw new DshTransportError("DSH authentication exchange failed"); }
      const cookie = response.headers.get("set-cookie")?.split(";")[0];
      if (![302, 303].includes(response.status) || !cookie) throw new DshTransportError("DSH authentication rejected; provide a current launch token through DSH_HOST_TOKEN");
      this.cookie = cookie;
    })();
    try { await this.authentication; } finally { this.authentication = undefined; }
  }
  private signal(signal?: AbortSignal) { return signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs); }

  async remote<T extends object>(endpoint: string, args: Record<string, unknown>, schema: z.ZodType<T, z.ZodTypeDef, unknown>, signal?: AbortSignal): Promise<DshUnaryResult<T>> {
    await this.authenticate(signal);
    const rpcId = randomUUID();
    let response: Response;
    try { response = await this.fetchImpl(new URL(`/api/${endpoint}`, this.baseUrl), {
      method: "POST", redirect: "error", headers: { "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: { args } }), signal: this.signal(signal),
    }); } catch { throw new DshTransportError(`DSH Remote ${endpoint} transport failed`); }
    if (!response.ok) throw new DshTransportError(response.status === 401 ? "DSH authentication required or cookie expired; refresh DSH_HOST_COOKIE or configure DSH_HOST_TOKEN with the current Host launch token" : `DSH Remote ${endpoint}: HTTP ${response.status}`);
    const body = reply.parse(await response.json());
    if (body.rpcId !== rpcId) throw new DshTransportError("DSH Remote response id mismatch");
    if (!body.result.ok) throw new DshRpcError(errorCode(body.result.error.code), body.result.error.message, body.result.error.details);
    return attachDshUnaryMetadata(schema.parse(body.result.value), { issuedRpcId: rpcId, method: endpoint });
  }

  companion(method: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const methods = ["registerInvocation", "registerSubmission", "closeSubmission", "attachSession", "summary"];
    if (!methods.includes(method)) throw new DshTransportError("unknown Agentlink companion method");
    return this.remote(`agentlink/${method}`, { input }, object, signal);
  }
  async hostDescribe(signal?: AbortSignal): Promise<DshUnaryResult<DshHostDescription>> {
    const models = await this.remote("session/modelCatalog", {}, catalogSchema, signal);
    return attachDshUnaryMetadata({ version: "unknown", cwd: "", provider: models.default.provider, model: models.default.model,
      attachedSessions: 0, canOpenPath: false, protocol: "remote", versionSource: "adapter-target" }, { issuedRpcId: randomUUID(), method: "session/modelCatalog" });
  }
  sessionList(signal?: AbortSignal) { return this.remote("session/list", { _request: {} }, dshSessionListValueSchema, signal); }
  sessionCreate(payload: { cwd: string; agentPreset?: string; sessionId?: string }, signal?: AbortSignal) {
    return this.remote("session/create", { request: payload }, dshSessionCreateValueSchema, signal);
  }
  async sessionModels(sessionId: string, signal?: AbortSignal): Promise<DshUnaryResult<DshSessionModels>> {
    const [list, catalog] = await Promise.all([this.sessionList(signal), this.remote("session/modelCatalog", {}, catalogSchema, signal)]);
    const row = list.items.find((item) => item.sessionId === sessionId);
    if (!row) throw new DshRpcError("session-not-found", "DSH session not found", { sessionId });
    const projection = row.projections as any;
    const current = projection?.values?.modelSelection?.next ?? projection?.values?.modelSelection?.lastUsed ?? catalog.default;
    return attachDshUnaryMetadata({ current, routable: catalog.routableProviders.includes(current.provider), groups: catalog.groups, failures: catalog.failures },
      { issuedRpcId: randomUUID(), method: "session/modelCatalog" });
  }
  async sessionPrompt(payload: Parameters<DshApi["sessionPrompt"]>[0], signal?: AbortSignal): ReturnType<DshApi["sessionPrompt"]> {
    const requestId = randomUUID();
    const result = await this.remote("session/prompt", { request: { ...payload, requestId } }, dshSessionPromptValueSchema, signal);
    return attachDshUnaryMetadata({ ...result }, { issuedRpcId: requestId, method: "session/prompt" });
  }
  sessionRename(sessionId: string, title: string, signal?: AbortSignal) { return this.remote("session/rename", { request: { sessionId, title } }, dshSessionRenameValueSchema, signal); }
  sessionCancel(sessionId: string, signal?: AbortSignal) { return this.remote("session/cancel", { request: { sessionId } }, dshSessionCancelValueSchema, signal); }
  sessionUpdateQueue(sessionId: string, itemId: string, action: { kind: "remove" }, signal?: AbortSignal) {
    return this.remote("session/updateQueue", { request: { sessionId, itemId, action } }, dshSessionUpdateQueueValueSchema, signal);
  }
  trackSessions(sessions: Array<{ sessionId: string; parentSessionId?: string; mode?: "one-shot" | "continuable" }>) {
    this.roots = new Set(sessions.map((session) => session.sessionId));
    for (const id of this.addresses.keys()) if (!this.roots.has(id)) this.addresses.delete(id);
    for (const [streamId, sessionId] of this.streams) if (!this.roots.has(sessionId)) {
      this.cancelledStreams.add(streamId); this.streams.delete(streamId);
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "cancel", streamId }));
    }
    for (const session of sessions) {
      if (session.parentSessionId && !session.mode) continue;
      const address = session.parentSessionId && session.mode
        ? { kind: "subagent", childSessionId: session.sessionId, parentSessionId: session.parentSessionId, mode: session.mode }
        : { kind: "session", sessionId: session.sessionId };
      this.addresses.set(session.sessionId, address);
      this.follow(session.sessionId, address);
    }
  }
  private async readSnapshot(address: Record<string, unknown>, maxMessages: number, signal?: AbortSignal): Promise<{records: unknown[]; hasMore: boolean; cursor: number}> {
    await this.authenticate(signal);
    const url = new URL("/api/remote.mux", this.baseUrl); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, { headers: this.cookie ? { Cookie: this.cookie } : {}, handshakeTimeout: this.timeoutMs });
    const bound = this.signal(signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, result?: {records: unknown[]; hasMore: boolean; cursor: number}) => {
        if (settled) return; settled = true; bound.removeEventListener("abort", abort);
        socket.close(); error ? reject(error) : resolve(result!);
      };
      const abort = () => finish(new DshTransportError("DSH snapshot cancelled or timed out"));
      bound.addEventListener("abort", abort, { once: true });
      socket.on("open", () => socket.send(JSON.stringify({ type: "open", streamId: "snapshot", endpoint: "session/follow", payload: { args: { request: { address, maxMessages } } } })));
      socket.on("error", () => finish(new DshTransportError("DSH snapshot connection failed")));
      socket.on("close", () => finish(new DshTransportError("DSH snapshot connection closed")));
      socket.on("message", (raw) => {
        try {
          const frame = record(JSON.parse(raw.toString()));
          if (frame.type === "error") return finish(new DshRpcError(errorCode(frame.error.code), frame.error.message, frame.error.details));
          if (frame.type === "item" && frame.value?.type === "snapshot") finish(undefined, z.object({ records: z.array(z.unknown()), hasMore: z.boolean(), cursor: z.number().int().min(-1) }).parse(frame.value));
        } catch { finish(new DshTransportError("invalid DSH snapshot")); }
      });
      if (bound.aborted) abort();
    });
  }
  private async history(address: Record<string, unknown>, options: { beforeSeq?: number; maxMessages?: number } = {}, signal?: AbortSignal): Promise<DshUnaryResult<DshSessionHistory>> {
    const id = String(address.sessionId ?? address.childSessionId);
    this.addresses.set(id, address);
    this.follow(id, address);
    const snapshot = await this.readSnapshot(address, options.maxMessages ?? 50, signal);
    if (options.beforeSeq === undefined) return attachDshUnaryMetadata({ events: remoteHistoryEntries(snapshot.records), hasMore: snapshot.hasMore }, { issuedRpcId: randomUUID(), method: "session/follow" });
    const page = await this.remote("session/page", { request: { address, throughSeq: snapshot.cursor, ...options } },
      z.object({ records: z.array(z.unknown()), hasMore: z.boolean() }), signal);
    return attachDshUnaryMetadata({ events: remoteHistoryEntries(page.records), hasMore: page.hasMore }, { issuedRpcId: randomUUID(), method: "session/page" });
  }
  sessionHistory(sessionId: string, options?: { beforeSeq?: number; maxMessages?: number }, signal?: AbortSignal) { return this.history({ kind: "session", sessionId }, options, signal); }
  subagentHistory(address: DshSubagentAddress, options?: { beforeSeq?: number; maxMessages?: number }, signal?: AbortSignal) { return this.history({ kind: "subagent", ...address }, options, signal); }
  subagentList(parentSessionId: string, signal?: AbortSignal): Promise<DshUnaryResult<DshSubagentListValue>> {
    return this.remote("subagents/list", { parentSessionId }, dshSubagentListValueSchema, signal);
  }
  async respond(message: DshClientResponse, signal?: AbortSignal) {
    const pending = this.pending.get(message.rpcId);
    if (!pending || !this.clientId) return { accepted: false as const, reason: "not-pending" as const };
    const value = message.result.value;
    if (value.sessionId !== pending.sessionId) return { accepted: false as const, reason: "bad-response" as const };
    if ((pending.kind === "question") !== ("answer" in value)) return { accepted: false as const, reason: "bad-response" as const };
    if ("approvalId" in value && value.approvalId !== pending.approvalId) return { accepted: false as const, reason: "bad-response" as const };
    const answer = "answer" in value ? value.answer : value.outcome;
    await this.remote("$events/result", { clientId: this.clientId, eventId: message.rpcId, outcome: { kind: "result", value: answer } }, z.preprocess(value => value === undefined ? {} : value, z.object({}).passthrough()), signal);
    this.pending.delete(message.rpcId);
    return { accepted: true as const };
  }
  private open(endpoint: string, args: Record<string, unknown>, streamId: string) {
    this.socket?.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));
  }
  private follow(id: string, address: Record<string, unknown>) {
    if (this.socket?.readyState !== WebSocket.OPEN || [...this.streams.values()].includes(id)) return;
    const streamId = randomUUID(); this.streams.set(streamId, id);
    this.open("session/follow", { request: { address, maxMessages: 1 } }, streamId);
  }
  async *openMux(signal: AbortSignal, onOpen?: () => void): AsyncIterable<DshServerRequest<DshMuxFrame>> {
    await this.authenticate(signal);
    const url = new URL("/api/remote.mux", this.baseUrl); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, { headers: this.cookie ? { Cookie: this.cookie } : {}, handshakeTimeout: this.timeoutMs });
    this.socket = socket; this.streams.clear(); this.cancelledStreams.clear(); this.pending.clear(); this.checkingEvents.clear(); this.clientId = undefined;
    const queue: Array<DshServerRequest<DshMuxFrame>> = [];
    let wake: (() => void) | undefined, failure: Error | undefined, ended = false;
    this.emit = (payload, id = randomUUID()) => { queue.push({ type: "server-request", rpcId: id, method: payload.type, payload: dshMuxFrameSchema.parse(payload) }); wake?.(); };
    const abort = () => { ended = true; socket.close(); wake?.(); };
    signal.addEventListener("abort", abort, { once: true });
    socket.on("open", () => { this.open("$events", {}, "events"); this.open("session/control", {}, "control"); for (const [id, address] of this.addresses) this.follow(id, address); });
    socket.on("error", () => { failure = new DshTransportError("DSH Remote WebSocket failed (check authentication and Host availability)"); wake?.(); });
    socket.on("close", () => { ended = true; wake?.(); });
    socket.on("message", (raw) => {
      try {
        const frame = record(JSON.parse(raw.toString()));
        if (this.cancelledStreams.has(frame.streamId)) { if (frame.type === "end" || frame.type === "error") this.cancelledStreams.delete(frame.streamId); return; }
        if (frame.type === "error") throw new DshRpcError(frame.error.code, frame.error.message, frame.error.details);
        if (frame.type === "end") throw new DshTransportError("DSH Remote logical stream ended");
        if (frame.type !== "item") throw new DshTransportError("invalid DSH Remote stream frame");
        const value = record(frame.value);
        if (frame.streamId === "events") {
          if (value.type === "ready") { this.clientId = value.clientId; onOpen?.(); }
          else void this.event(value).catch((error) => { failure = error instanceof Error ? error : new DshTransportError("DSH event handling failed"); wake?.(); });
        } else if (frame.streamId === "control") this.control(value);
        else {
          const sessionId = this.streams.get(frame.streamId);
          if (!sessionId) throw new DshTransportError("unknown DSH stream id");
          if (value.type === "snapshot") {
            for (const entry of remoteHistoryEntries(value.records)) this.emit!({ type: "session/event", sessionId, event: entry.event });
            this.emit!({ type: "session/subscribed", sessionId, lastSeq: value.cursor });
          } else if (value.type === "event") this.emit!({ type: "session/event", sessionId, event: dshSessionEventSchema.parse(value.event) });
        }
      } catch (error) { failure = error instanceof Error ? error : new DshTransportError("invalid DSH frame"); wake?.(); }
    });
    try {
      while (!signal.aborted) {
        if (failure) throw failure;
        const next = queue.shift(); if (next) { yield next; continue; }
        if (ended) throw new DshTransportError("DSH Remote connection closed");
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally { signal.removeEventListener("abort", abort); this.emit = undefined; this.socket = undefined; this.clientId = undefined; this.pending.clear(); this.checkingEvents.clear(); socket.close(); }
  }
  private control(value: Record<string, any>) {
    if (value.type === "baseline") {
      for (const [sessionId, items] of Object.entries(value.value.queues)) this.control({ type: "queue", sessionId, items });
      for (const [sessionId, jobs] of Object.entries(value.value.jobs)) this.control({ type: "jobs", sessionId, jobs });
      for (const [sessionId, block] of Object.entries(value.value.projections ?? {})) {
        const projection = record(block);
        if (projection.asOfSeq >= 0) for (const [key, item] of Object.entries(projection.values)) this.control({ type: "projection", sessionId, key, value: item, seq: projection.asOfSeq });
      }
    } else if (value.type === "queue") this.emit!({ type: "session/queue", sessionId: value.sessionId,
      items: value.items.map((item: any) => ({ ...item, message: { ...item.message, role: "user" } })) });
    else if (value.type === "jobs") this.emit!({ ...value, type: "session/jobs" } as DshMuxFrame);
    else if (value.type === "projection") this.emit!({ ...value, type: "session/projection" } as DshMuxFrame);
  }
  private async ensureOwned(sessionId: string): Promise<boolean> {
    if (this.roots.has(sessionId)) return true;
    if (this.roots.size === 0) return false;
    const list = await this.sessionList();
    const byId = new Map(list.items.map(row => [row.sessionId, row]));
    let row = byId.get(sessionId);
    const chain: typeof list.items = [], visited = new Set<string>();
    while (row && !this.roots.has(row.sessionId)) {
      if (visited.has(row.sessionId)) return false;
      visited.add(row.sessionId); chain.push(row);
      row = row.parentSessionId ? byId.get(row.parentSessionId) : undefined;
    }
    if (!row) return false;
    for (const child of chain.reverse()) {
      if (!child.parentSessionId) return false;
      const catalog = await this.subagentList(child.parentSessionId);
      const entry = catalog.entries.find(entry => entry.kind === "child" && entry.id === child.sessionId);
      if (!entry || entry.kind !== "child") return false;
      const address = { kind: "subagent", parentSessionId: child.parentSessionId, childSessionId: child.sessionId, mode: entry.mode };
      this.roots.add(child.sessionId); this.addresses.set(child.sessionId, address); this.follow(child.sessionId, address);
    }
    return true;
  }
  private async event(value: Record<string, any>) {
    if (value.type === "waterfall") {
      const sessionId = value.agentId, request = value.request;
      const check = { cancelled: false }, clientId = this.clientId;
      this.checkingEvents.set(value.eventId, check);
      let owned: boolean;
      try { owned = await this.ensureOwned(sessionId); }
      finally { this.checkingEvents.delete(value.eventId); }
      if (check.cancelled || clientId !== this.clientId) return;
      if (!owned) {
        if (this.clientId) void this.remote("$events/result", { clientId: this.clientId, eventId: value.eventId, outcome: { kind: "next" } }, z.preprocess(value => value === undefined ? {} : value, z.object({}).passthrough())).catch(() => undefined);
        return;
      }
      if (value.event === "user-questions/request") {
        this.pending.set(value.eventId, { sessionId, kind: "question" });
        this.emit!({ type: "question/requested", sessionId, questions: request.questions }, value.eventId);
      } else if (value.event === "approval/request") {
        this.pending.set(value.eventId, { sessionId, kind: "approval", approvalId: value.eventId });
        this.emit!({ ...request, type: "approval/requested", sessionId, approvalId: value.eventId }, value.eventId);
      } else if (this.clientId) {
        void this.remote("$events/result", { clientId: this.clientId, eventId: value.eventId, outcome: { kind: "next" } }, z.preprocess(value => value === undefined ? {} : value, z.object({}).passthrough())).catch(() => undefined);
      }
    } else if (value.type === "emit" && value.event === "api-session/added") {
      const sessionId = value.args?.[0]?.sessionId;
      if (typeof sessionId === "string") await this.ensureOwned(sessionId);
    } else if (value.type === "cancel") {
      const check = this.checkingEvents.get(value.eventId); if (check) check.cancelled = true;
      const pending = this.pending.get(value.eventId); if (!pending) return;
      this.pending.delete(value.eventId);
      if (pending.kind === "question") this.emit!({ type: "question/resolved", sessionId: pending.sessionId, questionRpcId: value.eventId, outcome: "cancelled" });
      else this.emit!({ type: "approval/resolved", sessionId: pending.sessionId, approvalId: pending.approvalId!, outcome: "cancelled" });
    }
  }
}
