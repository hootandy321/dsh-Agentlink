export type CallerClient = "codex" | "claude-code" | "other";

export type CallerModelSource = "caller-reported" | "adapter" | "configured" | "user-selected" | "unknown";

export type RequestOrigin = "delegated" | "manual-dsh" | "dsh-internal" | "recovered-unknown";

export type UsageSource = "llm-stream" | "session-history" | "adapter-final" | "manual-import";

export type RequestStatus = "started" | "completed" | "failed" | "cancelled" | "usage-missing";

export type MissingReason =
  | "usage-missing"
  | "dsh-price-missing"
  | "caller-model-missing"
  | "caller-price-missing"
  | "currency-mismatch"
  | "unsupported-comparison-bucket"
  | "non-comparable-origin";

export interface MoneyAmount {
  currency: string;
  picoUsd: string;
}

export interface CallerModelRef {
  provider: string;
  id: string;
  serviceTier?: string;
  source: CallerModelSource;
}

export interface CallerInfo {
  client: CallerClient | string;
  conversationId?: string;
  model?: CallerModelRef;
}

export interface RunAttribution {
  runId: string;
  callerClient: CallerClient | string;
  callerConversationId?: string;
  title?: string;
  createdAt: string;
}

export interface TaskAttribution {
  taskId: string;
  runId: string;
  rootSessionId: string;
  callerClient: CallerClient | string;
  createdAt: string;
}

export interface SessionAttribution {
  sessionId: string;
  runId: string;
  taskId?: string;
  rootSessionId?: string;
  parentSessionId?: string;
  origin: RequestOrigin;
  createdAt: string;
}

export interface SubmissionAttribution {
  submissionId: string;
  runId: string;
  taskId?: string;
  rootSessionId?: string;
  caller?: CallerInfo;
  createdAt: string;
}

export interface TokenUsageBuckets {
  inputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
}

export interface UsageRequestRecord {
  requestRecordId: string;
  runId: string;
  sessionId: string;
  taskId?: string;
  submissionId?: string;
  requestOrigin: RequestOrigin;
  provider: string;
  model: string;
  serviceTier?: string;
  purpose?: string;
  startedAt: string;
  completedAt?: string;
  status: RequestStatus;
  usage?: TokenUsageBuckets;
  usageSource?: UsageSource;
  callerModel?: CallerModelRef;
}

export interface PriceRates {
  inputUsdPerMillion: string;
  cacheReadUsdPerMillion?: string;
  cacheWriteUsdPerMillion?: string;
  outputUsdPerMillion: string;
}

export interface PriceLongContextRule {
  inputTokenThreshold: number;
  rates: PriceRates;
}

export interface PriceTimeWindowRule {
  name: string;
  daysOfWeekUtc?: number[];
  startMinuteUtc: number;
  endMinuteUtc: number;
  rates: PriceRates;
}

export interface ModelPriceEntry {
  priceId: string;
  provider: string;
  model: string;
  serviceTier?: string;
  currency: string;
  checkedAt: string;
  sourceUrl: string;
  sourceType: "official" | "custom";
  validFrom?: string;
  validTo?: string;
  rates: PriceRates;
  longContext?: PriceLongContextRule;
  timeWindows?: PriceTimeWindowRule[];
}

export interface PriceCatalog {
  entries: ModelPriceEntry[];
}

export interface RequestCost {
  requestRecordId: string;
  runId: string;
  sessionId: string;
  taskId?: string;
  comparable: boolean;
  missingReasons: MissingReason[];
  dshCost?: MoneyAmount;
  callerEquivalentCost?: MoneyAmount;
  saving?: MoneyAmount;
  dshPriceId?: string;
  callerPriceId?: string;
}

export interface CostCoverage {
  observedRequests: number;
  requestsWithUsage: number;
  dshPricedRequests: number;
  comparableRequests: number;
  unknownRequests: number;
  missingReasons: Partial<Record<MissingReason, number>>;
}

export interface AggregateCost {
  scope: "session" | "run" | "all";
  scopeId?: string;
  requestCount: number;
  comparableRequestCount: number;
  currency?: string;
  dshCostAllPriced?: MoneyAmount;
  dshCostComparable?: MoneyAmount;
  callerEquivalentCost?: MoneyAmount;
  saving?: MoneyAmount;
  partial: boolean;
  coverage: CostCoverage;
  requests: RequestCost[];
}
