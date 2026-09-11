import { z } from "zod";

export const callerClientSchema = z.string().min(1).max(80);
export const isoDateStringSchema = z.string().datetime({ offset: true });
export const idSchema = z.string().min(1).max(256);
export const optionalTextSchema = z.string().min(1).max(2048).optional();

export const callerModelSchema = z.object({
  provider: z.string().min(1).max(120),
  id: z.string().min(1).max(200),
  serviceTier: z.string().min(1).max(120).optional(),
  source: z.enum(["caller-reported", "adapter", "configured", "user-selected", "user-config", "unknown"]).optional()
}).strict();

export const callerInfoSchema = z.object({
  client: callerClientSchema,
  conversationId: z.string().min(1).max(256).optional(),
  model: callerModelSchema.optional()
}).strict();

export const requestOriginSchema = z.enum(["delegated", "manual-dsh", "dsh-internal", "recovered-unknown"]);
export const submissionStatusSchema = z.enum(["active", "finished", "cancelled", "failed"]);
export const closeModeSchema = z.enum(["turn-end", "manual"]);

export const tokenUsageBucketsSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional()
}).strict();

export const runRecordSchema = z.object({
  runId: idSchema,
  taskIds: z.array(idSchema),
  rootSessionIds: z.array(idSchema),
  title: optionalTextSchema,
  cwd: optionalTextSchema,
  caller: callerInfoSchema,
  createdAt: isoDateStringSchema,
  updatedAt: isoDateStringSchema
}).strict();

export const taskRecordSchema = z.object({
  taskId: idSchema,
  runId: idSchema,
  rootSessionId: idSchema,
  createdAt: isoDateStringSchema,
  updatedAt: isoDateStringSchema
}).strict();

export const sessionRecordSchema = z.object({
  sessionId: idSchema,
  runId: idSchema,
  taskId: idSchema,
  rootSessionId: idSchema.optional(),
  parentSessionId: idSchema.optional(),
  inheritedSubmissionId: idSchema.optional(),
  origin: requestOriginSchema,
  inheritedEventCount: z.number().int().nonnegative().optional(),
  firstLiveSeq: z.number().int().nonnegative().optional(),
  createdAt: isoDateStringSchema,
  updatedAt: isoDateStringSchema
}).strict();

export const submissionRecordSchema = z.object({
  submissionId: idSchema,
  runId: idSchema,
  taskId: idSchema,
  sessionId: idSchema,
  caller: callerInfoSchema,
  status: submissionStatusSchema,
  closeMode: closeModeSchema.optional(),
  submittedAt: isoDateStringSchema,
  closedAt: isoDateStringSchema.optional()
}).strict();

export const usageRecordSchema = z.object({
  requestRecordId: idSchema,
  sessionId: idSchema.optional(),
  runId: idSchema.optional(),
  taskId: idSchema.optional(),
  submissionId: idSchema.optional(),
  caller: callerInfoSchema.optional(),
  origin: requestOriginSchema,
  provider: z.string().min(1).max(120),
  model: z.string().min(1).max(200),
  serviceTier: z.string().min(1).max(120).optional(),
  purpose: z.string().min(1).max(200).optional(),
  startedAt: isoDateStringSchema,
  finishedAt: isoDateStringSchema.optional(),
  status: z.enum(["started", "finished", "errored", "aborted", "unknown"]),
  usage: tokenUsageBucketsSchema.optional(),
  usageSource: z.enum(["llm-stream", "historical", "manual"]),
  firstLiveSeq: z.number().int().nonnegative().optional()
}).strict();

export const subagentAddressSchema = z.object({
  parentSessionId: idSchema,
  childSessionId: idSchema,
  mode: z.enum(["one-shot", "continuable"])
}).strict();

const priceRatesSchema = z.object({
  inputUsdPerMillion: z.string().regex(/^\d+(?:\.\d+)?$/),
  cacheReadUsdPerMillion: z.string().regex(/^\d+(?:\.\d+)?$/).optional(),
  cacheWriteUsdPerMillion: z.string().regex(/^\d+(?:\.\d+)?$/).optional(),
  outputUsdPerMillion: z.string().regex(/^\d+(?:\.\d+)?$/)
}).strict();

export const priceRateSchema = z.object({
  priceId: idSchema,
  provider: z.string().min(1).max(120),
  model: z.string().min(1).max(200),
  serviceTier: z.string().min(1).max(120).optional(),
  currency: z.literal("USD"),
  checkedAt: isoDateStringSchema,
  sourceUrl: z.string().min(1).max(2048),
  sourceType: z.enum(["official", "custom"]),
  validFrom: isoDateStringSchema.optional(),
  validTo: isoDateStringSchema.optional(),
  rates: priceRatesSchema,
  longContext: z.object({ inputTokenThreshold: z.number().int().nonnegative(), rates: priceRatesSchema }).strict().optional(),
  timeWindows: z.array(z.object({
    name: z.string().min(1).max(120),
    daysOfWeekUtc: z.array(z.number().int().min(0).max(6)).optional(),
    startMinuteUtc: z.number().int().min(0).max(1439),
    endMinuteUtc: z.number().int().min(0).max(1440),
    rates: priceRatesSchema
  }).strict()).optional()
}).strict();

export const registerInvocationInputSchema = z.object({
  runId: idSchema.optional(),
  taskId: idSchema,
  rootSessionId: idSchema,
  title: optionalTextSchema,
  cwd: optionalTextSchema,
  caller: callerInfoSchema,
  submittedAt: isoDateStringSchema.optional(),
  closeMode: closeModeSchema.optional(),
  historical: z.boolean().optional()
}).strict();

export const registerSubmissionInputSchema = z.object({
  runId: idSchema,
  taskId: idSchema,
  sessionId: idSchema,
  caller: callerInfoSchema,
  submittedAt: isoDateStringSchema.optional(),
  closeMode: closeModeSchema.optional()
}).strict();

export const closeSubmissionInputSchema = z.object({
  submissionId: idSchema,
  status: z.enum(["finished", "cancelled", "failed"]).optional(),
  closedAt: isoDateStringSchema.optional()
}).strict();

export const attachSessionInputSchema = z.object({
  runId: idSchema,
  taskId: idSchema,
  sessionId: idSchema,
  rootSessionId: idSchema.optional(),
  parentSessionId: idSchema.optional(),
  inheritedSubmissionId: idSchema.optional(),
  origin: requestOriginSchema.optional(),
  inheritedEventCount: z.number().int().nonnegative().optional(),
  firstLiveSeq: z.number().int().nonnegative().optional(),
  attachedAt: isoDateStringSchema.optional()
}).strict();

export const listRunsInputSchema = z.object({ callerClient: z.string().min(1).max(80).optional(), limit: z.number().int().positive().max(500).optional() }).strict();
export const summaryInputSchema = z.object({ sessionId: idSchema.optional(), runId: idSchema.optional() }).strict();
export const detailsInputSchema = z.object({ sessionId: idSchema.optional(), runId: idSchema.optional(), limit: z.number().int().positive().max(500).optional() }).strict();

export const sessionsInputSchema = z.object({ runId: idSchema, limit: z.number().int().positive().max(500).optional() }).strict();
