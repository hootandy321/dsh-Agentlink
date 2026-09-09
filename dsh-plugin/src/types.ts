import type { AggregateCost, CallerInfo as CoreCallerInfo, ModelPriceEntry, RequestOrigin, TokenUsageBuckets } from "./cost-core/index.js";

export type SummaryAggregateCost = Omit<AggregateCost, "requests">;

export type CallerClient = "codex" | "claude-code" | "other" | string;

export interface CallerModel {
  provider: string;
  id: string;
  serviceTier?: string;
  source?: "caller-reported" | "adapter" | "configured" | "user-selected" | "user-config" | "unknown";
}

export interface CallerInfo {
  client: CallerClient;
  conversationId?: string;
  model?: CallerModel;
}

export interface RegisterInvocationInput {
  runId?: string;
  taskId: string;
  rootSessionId: string;
  title?: string;
  cwd?: string;
  caller: CallerInfo;
  submittedAt?: string;
  closeMode?: "turn-end" | "manual";
  historical?: boolean;
}

export interface RegisterSubmissionInput {
  runId: string;
  taskId: string;
  sessionId: string;
  caller: CallerInfo;
  submittedAt?: string;
  closeMode?: "turn-end" | "manual";
}

export interface CloseSubmissionInput {
  submissionId: string;
  status?: "finished" | "cancelled" | "failed";
  closedAt?: string;
}

export interface AttachSessionInput {
  runId: string;
  taskId: string;
  sessionId: string;
  rootSessionId?: string;
  parentSessionId?: string;
  inheritedSubmissionId?: string;
  origin?: RequestOrigin;
  inheritedEventCount?: number;
  firstLiveSeq?: number;
  attachedAt?: string;
}

export interface RunRecord {
  runId: string;
  taskIds: string[];
  rootSessionIds: string[];
  title?: string;
  cwd?: string;
  caller: CallerInfo;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord {
  taskId: string;
  runId: string;
  rootSessionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubagentAddress {
  parentSessionId: string;
  childSessionId: string;
  mode: "one-shot" | "continuable";
}

export interface SessionRecord {
  sessionId: string;
  runId: string;
  taskId: string;
  rootSessionId?: string;
  parentSessionId?: string;
  inheritedSubmissionId?: string;
  origin: RequestOrigin;
  inheritedEventCount?: number;
  firstLiveSeq?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SubmissionRecord {
  submissionId: string;
  runId: string;
  taskId: string;
  sessionId: string;
  caller: CallerInfo;
  status: "active" | "finished" | "cancelled" | "failed";
  closeMode?: "turn-end" | "manual";
  submittedAt: string;
  closedAt?: string;
}

export interface UsageRecord {
  requestRecordId: string;
  sessionId?: string;
  runId?: string;
  taskId?: string;
  submissionId?: string;
  caller?: CallerInfo;
  origin: RequestOrigin;
  provider: string;
  model: string;
  serviceTier?: string;
  purpose?: string;
  startedAt: string;
  finishedAt?: string;
  status: "started" | "finished" | "errored" | "aborted" | "unknown";
  usage?: TokenUsageBuckets;
  usageSource: "llm-stream" | "historical" | "manual";
  firstLiveSeq?: number;
}

export interface RegisterInvocationResult {
  runId: string;
  taskId: string;
  rootSessionId: string;
  submissionId?: string;
  registered: true;
}

export type PriceRate = ModelPriceEntry;

export interface CostSummaryItem {
  scope: "session" | "run" | "all";
  label: string;
  aggregate: SummaryAggregateCost;
}

export interface AgentlinkSummary {
  sessionId?: string;
  runId?: string;
  caller?: CallerInfo;
  generatedAt: string;
  items: CostSummaryItem[];
  notes: string[];
}

export interface RunListItem {
  runId: string;
  taskId: string;
  rootSessionId: string;
  title?: string;
  cwd?: string;
  caller: CallerInfo;
  sessionCount: number;
  requestCount: number;
  updatedAt: string;
}

export interface ListRunsInput {
  callerClient?: string;
  limit?: number;
}

export interface SummaryInput {
  sessionId?: string;
  runId?: string;
}

export interface DetailsInput {
  sessionId?: string;
  runId?: string;
  limit?: number;
}

export interface PluginConfig {
  prices?: PriceRate[];
}

export function toCoreCaller(caller: CallerInfo | undefined): CoreCallerInfo | undefined {
  if (caller === undefined) return undefined;
  return {
    client: caller.client,
    ...(caller.conversationId === undefined ? {} : { conversationId: caller.conversationId }),
    ...(caller.model === undefined
      ? {}
      : {
          model: {
            provider: caller.model.provider,
            id: normalizeCallerModelId(caller.model.id),
            ...(caller.model.serviceTier === undefined ? {} : { serviceTier: caller.model.serviceTier }),
            source: caller.model.source === "user-config" ? "configured" : (caller.model.source ?? "unknown")
          }
        })
  };
}

export function normalizeCallerModelId(model: string): string {
  return model === "gpt-5.6" ? "gpt-5.6-sol" : model;
}

export interface SessionsInput {
  runId: string;
  limit?: number;
}

export type SessionListRecord = Pick<SessionRecord, "sessionId" | "runId" | "taskId" | "rootSessionId" | "parentSessionId" | "origin" | "createdAt" | "updatedAt"> & { subagentAddress?: SubagentAddress };
