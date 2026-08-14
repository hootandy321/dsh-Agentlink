import { z } from "zod";

const nonEmptyString = z.string().min(1);

export const dshRpcErrorBodySchema = z
  .object({
    code: nonEmptyString,
    message: z.string(),
    details: z.unknown(),
  })
  .passthrough();

export type DshRpcErrorBody = z.infer<typeof dshRpcErrorBodySchema>;

export const dshHostDescriptionSchema = z
  .object({
    version: z.string(),
    cwd: z.string(),
    provider: z.string().optional(),
    model: z.string().optional(),
    attachedSessions: z.number().int().nonnegative(),
    canOpenPath: z.boolean(),
  })
  .passthrough();

export type DshHostDescription = z.infer<typeof dshHostDescriptionSchema>;

export const dshModelSelectionSchema = z
  .object({
    provider: nonEmptyString,
    model: nonEmptyString,
    reasoningEffort: nonEmptyString.optional(),
  })
  .passthrough();

export type DshModelSelection = z.infer<typeof dshModelSelectionSchema>;

const dshModelReasoningEffortSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    description: z.string().optional(),
  })
  .passthrough();

const dshModelCatalogModelSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    description: z.string().optional(),
    reasoning: z
      .object({
        efforts: z.array(dshModelReasoningEffortSchema).min(1),
        defaultEffort: nonEmptyString.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const dshModelProviderGroupSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    models: z.array(dshModelCatalogModelSchema),
  })
  .passthrough();

const dshModelCatalogFailureSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    message: z.string(),
  })
  .passthrough();

export const dshSessionModelsSchema = z
  .object({
    current: dshModelSelectionSchema,
    routable: z.boolean(),
    groups: z.array(dshModelProviderGroupSchema),
    failures: z.array(dshModelCatalogFailureSchema),
  })
  .passthrough();

export type DshSessionModels = z.infer<typeof dshSessionModelsSchema>;

export const dshSessionSummarySchema = z
  .object({
    sessionId: nonEmptyString,
    updatedAt: z.number(),
    running: z.boolean(),
    blank: z.boolean(),
    parentSessionId: nonEmptyString.optional(),
    origin: z.literal("subagent").optional(),
    cwd: z.string().optional(),
    agentPreset: z.string().optional(),
    projections: z.unknown().optional(),
  })
  .passthrough();

export type DshSessionSummary = z.infer<typeof dshSessionSummarySchema>;

export const dshSessionEventSchema = z
  .object({
    type: z.string(),
    seq: z.number().int().nonnegative(),
    time: z.number(),
    data: z.unknown(),
    sourceEventSeqs: z.array(z.number()).optional(),
    surfaceOp: z.unknown().optional(),
    ignorable: z.literal(true).optional(),
  })
  .passthrough();

export type DshSessionEvent = z.infer<typeof dshSessionEventSchema>;

const dshToolEventViewSchema = z
  .object({
    for: z.enum(["call", "result"]),
    view: z.object({ card: z.string() }).passthrough(),
  })
  .passthrough();

export const dshHistoryEntrySchema = z
  .object({
    event: dshSessionEventSchema,
    view: dshToolEventViewSchema.optional(),
  })
  .passthrough();

export type DshHistoryEntry = z.infer<typeof dshHistoryEntrySchema>;

export const dshSessionHistorySchema = z
  .object({
    events: z.array(dshHistoryEntrySchema),
    hasMore: z.boolean(),
    projections: z.unknown().optional(),
  })
  .passthrough();

export type DshSessionHistory = z.infer<typeof dshSessionHistorySchema>;

export const dshSessionListValueSchema = z
  .object({ items: z.array(dshSessionSummarySchema) })
  .passthrough();

export const dshSessionCreateValueSchema = z
  .object({
    sessionId: nonEmptyString,
    agentPreset: z.string().optional(),
  })
  .passthrough();

export const dshSessionPromptValueSchema = z
  .object({
    accepted: z.literal(true),
    command: z
      .object({
        kind: z.literal("success"),
        text: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const dshSessionRenameValueSchema = z
  .object({
    title: nonEmptyString,
    seq: z.number().int().nonnegative(),
  })
  .passthrough();

export const dshSessionCancelValueSchema = z.object({ accepted: z.literal(true) }).passthrough();
export const dshSessionUpdateQueueValueSchema = z.object({ accepted: z.literal(true) }).passthrough();

export const dshQueuedInboxItemSchema = z
  .object({
    id: nonEmptyString,
    placement: z.enum(["queued", "steering", "context"]),
    message: z
      .object({
        role: z.string(),
        content: z.array(z.unknown()),
      })
      .passthrough(),
  })
  .passthrough();

export type DshQueuedInboxItem = z.infer<typeof dshQueuedInboxItemSchema>;

export const dshServerRequestSchema = z
  .object({
    type: z.literal("server-request"),
    rpcId: z.string(),
    method: z.string(),
    payload: z.unknown(),
  })
  .passthrough();

export interface DshServerRequest<P = unknown> {
  type: "server-request";
  rpcId: string;
  method: string;
  payload: P;
}

export const dshSessionEventFrameSchema = z
  .object({
    type: z.literal("session/event"),
    sessionId: nonEmptyString,
    event: dshSessionEventSchema,
    view: dshToolEventViewSchema.optional(),
  })
  .passthrough();

export const dshSessionSubscribedFrameSchema = z
  .object({
    type: z.literal("session/subscribed"),
    sessionId: nonEmptyString,
    lastSeq: z.number().int(),
  })
  .passthrough();

export const dshApprovalRequestedFrameSchema = z
  .object({
    type: z.literal("approval/requested"),
    sessionId: nonEmptyString,
    approvalId: nonEmptyString,
    toolName: z.string(),
    callId: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export const dshApprovalResolvedFrameSchema = z
  .object({
    type: z.literal("approval/resolved"),
    sessionId: nonEmptyString,
    approvalId: nonEmptyString,
    outcome: z.enum(["allowed-once", "rejected", "cancelled", "unavailable"]),
  })
  .passthrough();

export const dshQuestionItemSchema = z
  .object({
    id: z.string(),
    question: z.string(),
    header: z.string().optional(),
    detail: z.string().optional(),
    options: z
      .array(z.object({ label: z.string(), description: z.string().optional() }).passthrough())
      .optional(),
    multiSelect: z.boolean().optional(),
    intent: z
      .object({ kind: z.literal("plan-review"), approve: z.string() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const dshQuestionRequestedFrameSchema = z
  .object({
    type: z.literal("question/requested"),
    sessionId: nonEmptyString,
    questions: z.array(dshQuestionItemSchema).min(1),
  })
  .passthrough();

export const dshQuestionResolvedFrameSchema = z
  .object({
    type: z.literal("question/resolved"),
    sessionId: nonEmptyString,
    questionRpcId: z.string(),
    outcome: z.enum(["answered", "cancelled"]),
  })
  .passthrough();

export const dshQueueFrameSchema = z
  .object({
    type: z.literal("session/queue"),
    sessionId: nonEmptyString,
    items: z.array(dshQueuedInboxItemSchema),
  })
  .passthrough();

const dshJobsFrameSchema = z
  .object({
    type: z.literal("session/jobs"),
    sessionId: nonEmptyString,
    jobs: z.array(z.unknown()),
  })
  .passthrough();

const dshProjectionFrameSchema = z
  .object({
    type: z.literal("session/projection"),
    sessionId: nonEmptyString,
    key: nonEmptyString,
    value: z.unknown(),
    seq: z.number().int().nonnegative(),
  })
  .passthrough();

export const dshStreamErrorFrameSchema = z
  .object({
    type: z.literal("stream/error"),
    error: dshRpcErrorBodySchema,
  })
  .passthrough();

export const dshMuxFrameSchema = z.union([
  dshSessionEventFrameSchema,
  dshSessionSubscribedFrameSchema,
  dshApprovalRequestedFrameSchema,
  dshApprovalResolvedFrameSchema,
  dshQuestionRequestedFrameSchema,
  dshQuestionResolvedFrameSchema,
  dshQueueFrameSchema,
  dshJobsFrameSchema,
  dshProjectionFrameSchema,
  dshStreamErrorFrameSchema,
]);

export type DshMuxFrame = z.infer<typeof dshMuxFrameSchema>;
export type DshApprovalRequestedFrame = z.infer<typeof dshApprovalRequestedFrameSchema>;
export type DshQuestionRequestedFrame = z.infer<typeof dshQuestionRequestedFrameSchema>;
export type DshQuestionItem = z.infer<typeof dshQuestionItemSchema>;
export type DshPendingFrame = DshApprovalRequestedFrame | DshQuestionRequestedFrame;
export type DshPendingEnvelope =
  | DshServerRequest<DshApprovalRequestedFrame>
  | DshServerRequest<DshQuestionRequestedFrame>;

export const dshQuestionAnswerSchema = z
  .object({
    id: z.string(),
    selected: z.array(z.string()),
    custom: z.string().optional(),
  })
  .strict();

export type DshQuestionAnswer = z.infer<typeof dshQuestionAnswerSchema>;

export interface DshClientResponse {
  type: "client-response";
  rpcId: string;
  result: {
    ok: true;
    value:
      | {
          sessionId: string;
          answer: { answers: DshQuestionAnswer[] };
        }
      | {
          sessionId: string;
          approvalId: string;
          outcome: "allowed-once" | "rejected";
        };
  };
}

export const dshRpcReceiptSchema = z.union([
  z.object({ accepted: z.literal(true) }).passthrough(),
  z
    .object({
      accepted: z.literal(false),
      reason: z.enum(["not-pending", "bad-response"]),
    })
    .passthrough(),
]);

export type DshRpcReceipt = z.infer<typeof dshRpcReceiptSchema>;

export const dshUnaryMetadata = Symbol.for("dsh-orchestrator.dshUnaryMetadata");

export interface DshUnaryMetadata {
  issuedRpcId: string;
  method: string;
}

export type DshUnaryResult<T extends object> = T & {
  readonly [dshUnaryMetadata]: DshUnaryMetadata;
};

export function attachDshUnaryMetadata<T extends object>(
  value: T,
  metadata: DshUnaryMetadata,
): DshUnaryResult<T> {
  const result = { ...value };
  return Object.defineProperty(result, dshUnaryMetadata, {
    value: Object.freeze({ ...metadata }),
    enumerable: false,
    configurable: false,
    writable: false,
  }) as DshUnaryResult<T>;
}

export function getDshUnaryMetadata<T extends object>(result: DshUnaryResult<T>): DshUnaryMetadata;
export function getDshUnaryMetadata(result: object): DshUnaryMetadata | undefined;
export function getDshUnaryMetadata(result: object): DshUnaryMetadata | undefined {
  return (result as { [dshUnaryMetadata]?: DshUnaryMetadata })[dshUnaryMetadata];
}

const dshSubagentChildBaseSchema = z.object({
  kind: z.literal("child"),
  id: nonEmptyString,
  activity: z.enum(["running", "inactive"]),
  hasChildren: z.boolean(),
});

export const dshSubagentListEntrySchema = z.union([
  dshSubagentChildBaseSchema.extend({ mode: z.literal("one-shot"), label: z.string().optional() }).passthrough(),
  dshSubagentChildBaseSchema.extend({ mode: z.literal("continuable"), label: z.string() }).passthrough(),
  z
    .object({
      kind: z.literal("diagnostic"),
      id: nonEmptyString,
      reason: z.enum(["corrupt", "unsupported", "unavailable"]),
    })
    .passthrough(),
]);

export const dshSubagentListValueSchema = z
  .object({
    entries: z.array(dshSubagentListEntrySchema),
    parentAvailable: z.boolean(),
  })
  .passthrough();

export type DshSubagentListValue = z.infer<typeof dshSubagentListValueSchema>;
export type DshSubagentListEntry = z.infer<typeof dshSubagentListEntrySchema>;
export type DshSubagentAddress = {
  parentSessionId: string;
  childSessionId: string;
  mode: "one-shot" | "continuable";
};

export interface DshApi {
  hostDescribe(signal?: AbortSignal): Promise<DshUnaryResult<DshHostDescription>>;
  sessionList(signal?: AbortSignal): Promise<DshUnaryResult<z.infer<typeof dshSessionListValueSchema>>>;
  sessionCreate(
    payload: { cwd: string; agentPreset?: string; sessionId?: string },
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<z.infer<typeof dshSessionCreateValueSchema>>>;
  sessionModels(sessionId: string, signal?: AbortSignal): Promise<DshUnaryResult<DshSessionModels>>;
  sessionPrompt(
    payload: {
      sessionId: string;
      mode: "queue" | "steer";
      content: Array<{ type: "text"; text: string }>;
      clientTimeZone?: string;
    },
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<z.infer<typeof dshSessionPromptValueSchema>>>;
  sessionRename(
    sessionId: string,
    title: string,
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<z.infer<typeof dshSessionRenameValueSchema>>>;
  sessionHistory(
    sessionId: string,
    options?: { beforeSeq?: number; maxMessages?: number },
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<DshSessionHistory>>;
  sessionCancel(sessionId: string, signal?: AbortSignal): Promise<DshUnaryResult<z.infer<typeof dshSessionCancelValueSchema>>>;
  sessionUpdateQueue(
    sessionId: string,
    itemId: string,
    action: { kind: "remove" },
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<z.infer<typeof dshSessionUpdateQueueValueSchema>>>;
  subagentList(parentSessionId: string, signal?: AbortSignal): Promise<DshUnaryResult<DshSubagentListValue>>;
  subagentHistory(
    address: DshSubagentAddress,
    options?: { beforeSeq?: number; maxMessages?: number },
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<DshSessionHistory>>;
  respond(message: DshClientResponse, signal?: AbortSignal): Promise<DshRpcReceipt>;
  openMux(signal: AbortSignal, onOpen?: () => void): AsyncIterable<DshServerRequest<DshMuxFrame>>;
}
