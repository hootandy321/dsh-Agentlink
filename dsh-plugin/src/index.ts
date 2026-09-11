import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type { GenerateOptions, StreamChunk, TokenUsage } from "@deepseek-ai/dsh-llm";
import "@deepseek-ai/dsh-session";
import "@deepseek-ai/dsh-agent";
import {
  AgentlinkStore,
  agentlinkDomain,
  type AgentlinkTables,
  memoryTables,
  type RuntimeSessionLike
} from "./store.js";
import type {
  AttachSessionInput,
  CloseSubmissionInput,
  DetailsInput,
  ListRunsInput,
  PluginConfig,
  RegisterInvocationInput,
  RegisterSubmissionInput,
  SessionsInput,
  SummaryInput,
  SessionListRecord,
  SubagentAddress,
  UsageRecord
} from "./types.js";
import { priceRateSchema } from "./schemas.js";

export const name = "dsh-agentlink-dsh-plugin";
export const inject = ["llm", "sessions", "agents", "subagents"];

const priceRatesConfigSchema = z.object({
  inputUsdPerMillion: z.string().required(),
  cacheReadUsdPerMillion: z.string(),
  cacheWriteUsdPerMillion: z.string(),
  outputUsdPerMillion: z.string().required()
});

const priceSchema = z.object({
  priceId: z.string().required(),
  provider: z.string().required(),
  model: z.string().required(),
  serviceTier: z.string(),
  currency: z.const("USD").default("USD"),
  checkedAt: z.string().required(),
  sourceUrl: z.string().required(),
  sourceType: z.union([z.const("official"), z.const("custom")]).default("custom"),
  validFrom: z.string(),
  validTo: z.string(),
  rates: priceRatesConfigSchema,
  longContext: z.object({
    inputTokenThreshold: z.number().required(),
    rates: priceRatesConfigSchema
  }).default(undefined as never),
  timeWindows: z.array(z.object({
    name: z.string().required(),
    daysOfWeekUtc: z.array(z.number()),
    startMinuteUtc: z.number().required(),
    endMinuteUtc: z.number().required(),
    rates: priceRatesConfigSchema
  }))
});

export const Config = z.object({
  prices: z.array(priceSchema).default([])
});

let activeStore: AgentlinkStore | undefined;

export class AgentlinkRemoteGateway extends TypertRemoteService {
  constructor(private readonly agentlinkCtx: Context) {
    super(agentlinkCtx, "agentlink");
  }

  @Remote("registerInvocation")
  async registerInvocation(input: RegisterInvocationInput) {
    return requireStore().registerInvocation(input);
  }

  @Remote("attachSession")
  async attachSession(input: AttachSessionInput) {
    return requireStore().attachSession(input);
  }

  @Remote("registerSubmission")
  async registerSubmission(input: RegisterSubmissionInput) {
    return requireStore().registerSubmission(input);
  }

  @Remote("closeSubmission")
  async closeSubmission(input: CloseSubmissionInput) {
    return requireStore().closeSubmission(input);
  }

  @Remote("listRuns")
  async listRuns(input: ListRunsInput) {
    return requireStore().listRuns(input);
  }

  @Remote("summary")
  async summary(input: SummaryInput) {
    return requireStore().summary(input);
  }

  @Remote("details")
  async details(input: DetailsInput) {
    return requireStore().details(input);
  }

  @Remote("sessions")
  async sessions(input: SessionsInput): Promise<SessionListRecord[]> {
    return enrichSessionListWithSubagentCatalog(this.agentlinkCtx, requireStore().sessions(input));
  }

  @Remote("prices")
  async prices() {
    return requireStore().prices();
  }
}

export function apply(ctx: Context, rawConfig: PluginConfig = {}): void {
  const config = normalizeConfig(rawConfig);
  let memoryFallbackTables: AgentlinkTables | undefined;
  const finishInstall = (tables: AgentlinkTables) => {
    const store = new AgentlinkStore(tables, () => new Date(), config, tables === memoryFallbackTables ? "memory" : "persistent");
    activeStore = store;
    ctx.plugin(AgentlinkRemoteGateway);
    ctx.effect(() => {
      const disposers = [
        ctx.on("llm/stream", (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) =>
          observeLlmStream(store, options, next)
        ),
        ctx.on("session/created", (session: RuntimeSessionLike) => {
          void store.attachChildSessionFromRuntime(session).catch((error) => {
            ctx.logger?.warn?.(`dsh-agentlink: child session attribution failed: ${String(error)}`);
          });
        }),
        ctx.on("agent/created", ({ agent }: { agent: { session?: RuntimeSessionLike } }) => {
          if (agent.session !== undefined) {
            void store.attachChildSessionFromRuntime(agent.session).catch((error) => {
              ctx.logger?.warn?.(`dsh-agentlink: child agent attribution failed: ${String(error)}`);
            });
          }
        }),
        ctx.on("session/event", (session: RuntimeSessionLike, event: { type?: string }) => {
          if (event.type === "turn/end") {
            const sessionId = typeof session.id === "string" ? session.id : undefined;
            if (sessionId !== undefined) {
              void store.closeTurnSubmissions(sessionId).catch((error) => {
                ctx.logger?.warn?.(`dsh-agentlink: submission turn close failed: ${String(error)}`);
              });
            }
          }
        })
      ];
      return () => {
        for (const dispose of disposers.reverse()) dispose();
        if (activeStore === store) activeStore = undefined;
      };
    }, "dsh-agentlink: usage collector and attribution listeners");

    for (const session of runtimeSessions(ctx)) {
      void store.attachChildSessionFromRuntime(session).catch(() => undefined);
    }
  };

  if ("storageDomain" in ctx) {
    ctx.inject(["storageDomain"], async (domainCtx: Context) => {
      try {
        const domain = await domainCtx.storageDomain.open(agentlinkDomain);
        finishInstall({
          runs: domain.table("runs") as AgentlinkTables["runs"],
          tasks: domain.table("tasks") as AgentlinkTables["tasks"],
          sessions: domain.table("sessions") as AgentlinkTables["sessions"],
          submissions: domain.table("submissions") as AgentlinkTables["submissions"],
          usage: domain.table("usage") as AgentlinkTables["usage"],
          prices: domain.table("prices") as AgentlinkTables["prices"]
        });
        ctx.effect(() => () => {
          void domain.close?.();
        }, "dsh-agentlink: close storage domain");
      } catch (error) {
        ctx.logger?.warn?.(`dsh-agentlink: storage unavailable, using in-memory state: ${String(error)}`);
        memoryFallbackTables = memoryTables();
        finishInstall(memoryFallbackTables);
      }
    });
    return;
  }

  memoryFallbackTables = memoryTables();
  finishInstall(memoryFallbackTables);
}

export async function* observeLlmStream(
  store: AgentlinkStore,
  options: GenerateOptions,
  next: () => AsyncIterable<StreamChunk>
): AsyncIterable<StreamChunk> {
  const startedAt = new Date().toISOString();
  const requestRecordId = randomId("req");
  const sessionId = typeof options.sessionId === "string" ? options.sessionId : undefined;
  const attribution = store.attributionFor(sessionId, startedAt);
  let usage: TokenUsage | undefined;
  let terminal: UsageRecord["status"] = "unknown";

  try {
    try {
      await store.recordUsage({
        requestRecordId,
        sessionId,
        runId: attribution.runId,
        taskId: attribution.taskId,
        submissionId: attribution.submissionId,
        caller: attribution.caller,
        origin: attribution.caller === undefined ? "manual-dsh" : options.purpose === undefined ? "delegated" : "dsh-internal",
        provider: options.provider,
        model: options.model,
        purpose: options.purpose,
        startedAt,
        status: "started",
        usageSource: "llm-stream",
        firstLiveSeq: attribution.firstLiveSeq
      });
    } catch {
      store.markCollectorError();
    }

    for await (const chunk of next()) {
      if (chunk.type === "usage") usage = chunk.usage;
      if (chunk.type === "finish") terminal = finishStatus(chunk.reason);
      yield chunk;
    }
  } finally {
    try {
      await store.recordUsage({
        requestRecordId,
        sessionId,
        runId: attribution.runId,
        taskId: attribution.taskId,
        submissionId: attribution.submissionId,
        caller: attribution.caller,
        origin: attribution.caller === undefined ? "manual-dsh" : options.purpose === undefined ? "delegated" : "dsh-internal",
        provider: options.provider,
        model: options.model,
        purpose: options.purpose,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: terminal,
        usage,
        usageSource: "llm-stream",
        firstLiveSeq: attribution.firstLiveSeq
      });
    } catch {
      store.markCollectorError();
    }
  }
}

function requireStore(): AgentlinkStore {
  if (activeStore === undefined) {
    throw new Error("dsh-agentlink: store is not initialized");
  }
  return activeStore;
}

function finishStatus(reason: unknown): UsageRecord["status"] {
  if (typeof reason !== "object" || reason === null || !("kind" in reason)) return "finished";
  const kind = Reflect.get(reason, "kind");
  if (kind === "error") return "errored";
  if (kind === "aborted") return "aborted";
  return "finished";
}

function randomId(prefix: string): string {
  const cryptoApi = globalThis.crypto;
  const id = cryptoApi?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
}

export async function enrichSessionListWithSubagentCatalog(ctx: Context, rows: SessionListRecord[]): Promise<SessionListRecord[]> {
  const runtime = (ctx as unknown as { subagents?: { listChildren?: (parentSessionId: string, signal?: AbortSignal) => Promise<unknown[]> } }).subagents;
  if (runtime?.listChildren === undefined) return rows;
  const parentIds = [...new Set(rows
    .filter((row) => row.origin === "dsh-internal" && row.parentSessionId !== undefined)
    .map((row) => row.parentSessionId as string))];
  if (parentIds.length === 0) return rows;

  const byParent = new Map<string, unknown[]>();
  for (const parentSessionId of parentIds) {
    try {
      byParent.set(parentSessionId, await runtime.listChildren(parentSessionId));
    } catch {
      byParent.set(parentSessionId, []);
    }
  }

  return rows.map((row) => {
    if (row.origin !== "dsh-internal" || row.parentSessionId === undefined) return row;
    const entry = byParent.get(row.parentSessionId)?.find((candidate) => {
      if (typeof candidate !== "object" || candidate === null) return false;
      return Reflect.get(candidate, "kind") === "child" && Reflect.get(candidate, "id") === row.sessionId;
    });
    if (typeof entry !== "object" || entry === null) return row;
    const mode = Reflect.get(entry, "mode");
    if (mode !== "one-shot" && mode !== "continuable") return row;
    return {
      ...row,
      subagentAddress: { parentSessionId: row.parentSessionId, childSessionId: row.sessionId, mode } satisfies SubagentAddress
    };
  });
}

function runtimeSessions(ctx: Context): RuntimeSessionLike[] {
  const maybeSessions = (ctx as unknown as { sessions?: { list?: () => RuntimeSessionLike[] } }).sessions;
  try {
    return maybeSessions?.list?.() ?? [];
  } catch {
    return [];
  }
}

function normalizeConfig(config: PluginConfig): PluginConfig {
  return {
    prices: (config.prices ?? []).map((price) => priceRateSchema.parse({ ...price, sourceType: price.sourceType ?? "custom" }))
  };
}
