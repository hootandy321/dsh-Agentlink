import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeService, CallerInput, WritePreconditions } from "./bridge-service.js";
import { DelegationSetupError } from "./bridge-service.js";
import { PendingInteractionError } from "./connection-manager.js";
import { DshRpcError, DshTransportError } from "./dsh-client.js";
import { EventLedgerError } from "./event-ledger.js";
import {
  STATUS_INCLUDE_VALUES,
  TAIL_KIND_VALUES,
  projectStatus,
  projectTail,
  projectTaskList,
  projectWait,
  type StatusInclude,
  type TailKind,
} from "./response-view.js";

const taskIdSchema = z.string().regex(/^dsh_[a-f0-9]{12}$/);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const writeOnce = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const ERROR_DETAIL_KEYS = new Set([
  "taskId",
  "sessionId",
  "rootSessionId",
  "childSessionId",
  "requestId",
  "submissionId",
  "runId",
  "cursor",
  "sinceCursor",
  "currentCursor",
  "earliestCursor",
  "revision",
  "expectedRevision",
  "currentRevision",
  "code",
  "stage",
  "requestedPreset",
  "resolvedPreset",
  "presetId",
  "promptSent",
]);

function safeDetailValue(value: unknown): unknown {
  if (value === null) return value;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  return undefined;
}

function errorDetailsSummary(details: unknown): Record<string, unknown> {
  if (details === null || typeof details !== "object" || Array.isArray(details)) {
    return { availableDetails: false };
  }
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!ERROR_DETAIL_KEYS.has(key)) continue;
    const safe = safeDetailValue(value);
    if (safe !== undefined) summary[key] = safe;
  }
  const redacted = Object.keys(details).some((key) => !(key in summary));
  return { ...summary, availableDetails: redacted || Object.keys(summary).length > 0, detailsHint: "Use the relevant read tool with explicit include fields for selected details." };
}

function errorBody(error: unknown): Record<string, unknown> {
  if (error instanceof DshRpcError) {
    return { error: error.name, code: error.code, message: error.message, details: errorDetailsSummary(error.details) };
  }
  if (error instanceof DshTransportError) {
    return { error: error.name, code: "host_unreachable", message: error.message };
  }
  if (error instanceof PendingInteractionError) {
    return { error: error.name, code: error.code, message: error.message };
  }
  if (error instanceof EventLedgerError) {
    return { error: error.name, code: error.code, message: error.message, details: errorDetailsSummary(error.details) };
  }
  if (error instanceof DelegationSetupError) {
    return {
      error: error.name,
      code: "delegation_setup_failed",
      stage: error.stage,
      message: error.message,
      sessionId: error.sessionId,
      taskId: error.taskId,
    };
  }
  if (error instanceof Error) {
    const extra = "code" in error && typeof error.code === "string" ? { code: error.code } : {};
    const details = "details" in error ? { details: errorDetailsSummary(error.details) } : {};
    return { error: error.name, ...extra, message: error.message, ...details };
  }
  return { error: "UnknownError", message: String(error) };
}

function failure(error: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(errorBody(error), null, 2) }] };
}

function writePreconditions(sinceCursor?: number, expectedRevision?: number): WritePreconditions {
  return {
    ...(sinceCursor === undefined ? {} : { sinceCursor }),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
}

async function handled<T>(operation: () => Promise<T>) {
  try {
    return result(await operation());
  } catch (error) {
    return failure(error);
  }
}

function normalizeIncludes(include?: StatusInclude[]): StatusInclude[] {
  return include ?? [];
}

function normalizeKinds(kinds?: TailKind[]): TailKind[] {
  return kinds?.length ? kinds : ["attention"];
}

function projectDelegateResult(value: Record<string, any>, include: StatusInclude[] = []) {
  if (value.wait === undefined) return value;
  const wait = projectWait(value.wait, include, { includeResult: value.wait?.reason !== "activity" && value.wait?.timedOut !== true });
  return { ...value, wait };
}

async function statusWithCost(service: BridgeService, taskId: string, include: StatusInclude[]) {
  const status = await service.status(taskId);
  if (include.includes("cost")) {
    return { ...status, cost: await service.costSummary(taskId) };
  }
  return status;
}

const callerSchema: z.ZodType<CallerInput> = z
  .object({
    client: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
    model: z
      .object({
        provider: z.string().min(1),
        id: z.string().min(1),
        serviceTier: z.string().min(1).optional(),
        source: z.enum(["caller-reported", "adapter", "user-config", "unknown"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function createMcpServer(service: BridgeService): McpServer {
  const server = new McpServer({ name: "dsh-agentlink", version: "0.2.0" });

  server.registerTool(
    "dsh_host_status",
    {
      description: "Report the connect-only bridge state and current official DSH Web Host capabilities.",
      inputSchema: z.object({}).strict(),
      annotations: readOnly,
    },
    async () => handled(() => service.hostStatus()),
  );

  server.registerTool(
    "dsh_delegate",
    {
      description:
        "Create a root session on the configured official DSH Web Host, register Agentlink attribution, and queue the initial prompt. Uses DSH's configured model; caller.model is only a comparison label, never a DSH route override. Omitted caller.model.serviceTier defaults to standard API pricing. Detached by default. workspaceMode is only a bridge-local cooperative claim and does not select or verify the DSH sandbox.",
      inputSchema: z
        .object({
          prompt: z.string().min(1),
          cwd: z.string().min(1).describe("Existing absolute directory visible to the DSH Host."),
          runId: z.string().min(1).optional(),
          caller: callerSchema.optional(),
          agentPreset: z
            .string()
            .min(1)
            .optional()
            .describe("DSH agent composition/preset name. This does not express workspace ownership or verified sandbox policy."),
          title: z.string().min(1).optional(),
          waitSeconds: z.number().int().min(0).max(30).default(0),
          include: z.array(z.enum(STATUS_INCLUDE_VALUES)).default([]),
          workspaceMode: z
            .enum(["read-only", "exclusive-write"])
            .default("exclusive-write")
            .describe("Bridge-local cooperative workspace claim only; it is not a DSH Host filesystem sandbox selector or verifier."),
        })
        .strict(),
      annotations: writeOnce,
    },
    async ({ prompt, cwd, runId, caller, agentPreset, title, waitSeconds, include, workspaceMode }) =>
      handled(() =>
        service
          .delegate({
            prompt,
            cwd,
            ...(runId === undefined ? {} : { runId }),
            ...(caller === undefined ? {} : { caller }),
            waitSeconds,
            workspaceMode,
            ...(agentPreset === undefined ? {} : { agentPreset }),
            ...(title === undefined ? {} : { title }),
          })
          .then((value) => projectDelegateResult(value, normalizeIncludes(include))),
      ),
  );

  const followupSchema = z
    .object({
      taskId: taskIdSchema,
      prompt: z.string().min(1),
      mode: z.enum(["queue", "steer"]).default("queue"),
      caller: callerSchema.optional(),
      sinceCursor: z.number().int().min(0).optional(),
      expectedRevision: z.number().int().min(0).optional(),
    })
    .strict();
  const followupDescription =
    "Continue the same root DSH session. queue targets the next turn; steer targets the active turn's next step. The write is never automatically retried.";
  server.registerTool(
    "dsh_followup",
    { description: followupDescription, inputSchema: followupSchema, annotations: writeOnce },
    async ({ taskId, prompt, mode, caller, sinceCursor, expectedRevision }) =>
      handled(() => service.continueTask(taskId, prompt, mode, writePreconditions(sinceCursor, expectedRevision), caller)),
  );
  server.registerTool(
    "dsh_continue",
    { description: `Compatibility alias for dsh_followup. ${followupDescription}`, inputSchema: followupSchema, annotations: writeOnce },
    async ({ taskId, prompt, mode, caller, sinceCursor, expectedRevision }) =>
      handled(() => service.continueTask(taskId, prompt, mode, writePreconditions(sinceCursor, expectedRevision), caller)),
  );

  server.registerTool(
    "dsh_status",
    {
      description:
        "Return a compact supervision summary by default. Use include to fetch selected result, interaction, queue, workspace, session, connection, route, or recovery details.",
      inputSchema: z.object({ taskId: taskIdSchema, include: z.array(z.enum(STATUS_INCLUDE_VALUES)).default([]) }).strict(),
      annotations: readOnly,
    },
    async ({ taskId, include }) =>
      handled(() => statusWithCost(service, taskId, normalizeIncludes(include)).then((status) => projectStatus(status, normalizeIncludes(include)))),
  );

  server.registerTool(
    "dsh_tail",
    {
      description:
        "Read bounded event digests using bridge coordination cursors. Conversation content is fetched from DSH history when reachable and is never copied into bridge persistence.",
      inputSchema: z
        .object({
          taskId: taskIdSchema,
          sinceCursor: z.number().int().min(0).default(0),
          maxEvents: z.number().int().min(1).max(500).default(20),
          maxBytes: z.number().int().min(1_024).max(1_000_000).default(64_000),
          kinds: z.array(z.enum(TAIL_KIND_VALUES)).default(["attention"]),
          sessionIds: z.array(z.string().min(1)).optional(),
        })
        .strict(),
      annotations: readOnly,
    },
    async ({ taskId, sinceCursor, maxEvents, maxBytes, kinds, sessionIds }) =>
      handled(() => service.tail(taskId, sinceCursor, maxEvents, maxBytes, normalizeKinds(kinds), sessionIds).then(projectTail)),
  );

  server.registerTool(
    "dsh_wait",
    {
      description:
        "Wait at most 30 seconds. wakeOn=attention returns for terminal results, pending interactions, or availability/recovery problems; wakeOn=activity also returns on ordinary cursor progress.",
      inputSchema: z
        .object({
          taskId: taskIdSchema,
          timeoutSec: z.number().int().min(0).max(30).default(30),
          sinceCursor: z.number().int().min(0).optional(),
          wakeOn: z.enum(["attention", "activity"]).default("attention"),
          include: z.array(z.enum(STATUS_INCLUDE_VALUES)).default([]),
        })
        .strict(),
      annotations: readOnly,
    },
    async ({ taskId, timeoutSec, sinceCursor, wakeOn, include }) =>
      handled(() =>
        service
          .wait(taskId, timeoutSec, sinceCursor, wakeOn)
          .then(async (wait) => {
            const normalized = normalizeIncludes(include);
            const status = normalized.includes("cost") ? { ...wait.status, cost: await service.costSummary(taskId) } : wait.status;
            return projectWait({ ...wait, status }, normalized, { includeResult: wait.reason !== "activity" && wait.timedOut !== true });
          }),
      ),
  );

  server.registerTool(
    "dsh_observe",
    {
      description: "Compatibility observation alias. Prefer dsh_wait with wakeOn plus dsh_tail kinds/sessionIds for event details.",
      inputSchema: z
        .object({
          taskId: taskIdSchema,
          afterCursor: z.number().int().min(0).optional(),
          waitSeconds: z.number().int().min(0).max(30).default(0),
          wakeOn: z.enum(["attention", "activity"]).default("attention"),
          include: z.array(z.enum(STATUS_INCLUDE_VALUES)).default([]),
        })
        .strict(),
      annotations: readOnly,
    },
    async ({ taskId, afterCursor, waitSeconds, wakeOn, include }) =>
      handled(() =>
        service
          .wait(taskId, waitSeconds, afterCursor, wakeOn)
          .then(async (wait) => {
            const normalized = normalizeIncludes(include);
            const status = normalized.includes("cost") ? { ...wait.status, cost: await service.costSummary(taskId) } : wait.status;
            return {
            deprecatedAlias: "dsh_observe is a compatibility alias; prefer dsh_wait with wakeOn plus dsh_tail kinds/sessionIds for event details",
            ...projectWait({ ...wait, status }, normalized, { includeResult: wait.reason !== "activity" && wait.timedOut !== true }),
            };
          })),
  );

  server.registerTool(
    "dsh_cancel",
    {
      description:
        "scope=turn cancels only the active root turn and preserves queued work. scope=queue non-atomically removes each item from the latest mux queue snapshot.",
      inputSchema: z
        .object({
          taskId: taskIdSchema,
          scope: z.enum(["turn", "queue"]).default("turn"),
          sinceCursor: z.number().int().min(0).optional(),
          expectedRevision: z.number().int().min(0).optional(),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ taskId, scope, sinceCursor, expectedRevision }) =>
      handled(() => service.cancel(taskId, scope, writePreconditions(sinceCursor, expectedRevision))),
  );

  server.registerTool(
    "dsh_list",
    {
      description: "List bridge task mappings as compact supervision summaries. Use include for selected detail categories.",
      inputSchema: z.object({ include: z.array(z.enum(STATUS_INCLUDE_VALUES)).default([]) }).strict(),
      annotations: readOnly,
    },
    async ({ include }) =>
      handled(async () => {
        const normalized = normalizeIncludes(include);
        const statuses = await service.listTasks();
        if (!normalized.includes("cost")) return projectTaskList(statuses, normalized);
        return projectTaskList(
          await Promise.all(statuses.map((status) => service.costSummary(status.taskId).then((cost) => ({ ...status, cost })))),
          normalized,
        );
      }),
  );

  server.registerTool(
    "dsh_release_workspace",
    {
      description:
        "Explicitly release this bridge task's persistent workspace claim. This does not close the DSH session or stop other clients from editing the directory.",
      inputSchema: z.object({ taskId: taskIdSchema }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ taskId }) => handled(() => service.releaseWorkspace(taskId)),
  );

  server.registerTool(
    "dsh_answer_question",
    {
      description:
        "Answer one currently pending typed DSH question request. The requestId, task lineage, question ids/order, and selections are validated locally before one non-retried /api/respond write.",
      inputSchema: z
        .object({
          taskId: taskIdSchema,
          requestId: z.string().min(1),
          sinceCursor: z.number().int().min(0).optional(),
          expectedRevision: z.number().int().min(0).optional(),
          answers: z
            .array(
              z
                .object({
                  id: z.string().min(1),
                  selected: z.array(z.string()),
                  custom: z.string().optional(),
                })
                .strict(),
            )
            .min(1),
        })
        .strict(),
      annotations: writeOnce,
    },
    async ({ taskId, requestId, answers, sinceCursor, expectedRevision }) =>
      handled(() => service.answerQuestion(taskId, requestId, answers, writePreconditions(sinceCursor, expectedRevision))),
  );

  server.registerTool(
    "dsh_resolve_approval",
    {
      description:
        "Resolve one pending DSH sandbox-escalation approval as allow_once or reject. Never auto-allows; keep this tool behind the caller's human approval prompt before permitting allow_once.",
      inputSchema: z
        .object({
          taskId: taskIdSchema,
          requestId: z.string().min(1),
          outcome: z.enum(["allow_once", "reject"]),
          sinceCursor: z.number().int().min(0).optional(),
          expectedRevision: z.number().int().min(0).optional(),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      _meta: { "anthropic/requiresUserInteraction": true },
    },
    async ({ taskId, requestId, outcome, sinceCursor, expectedRevision }) =>
      handled(() => service.resolveApproval(taskId, requestId, outcome, writePreconditions(sinceCursor, expectedRevision))),
  );

  return server;
}
