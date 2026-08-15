import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeService, WritePreconditions } from "./bridge-service.js";
import { DelegationSetupError } from "./bridge-service.js";
import { PendingInteractionError } from "./connection-manager.js";
import { DshRpcError, DshTransportError } from "./dsh-client.js";
import { EventLedgerError } from "./event-ledger.js";

const taskIdSchema = z.string().regex(/^dsh_[a-f0-9]{12}$/);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const writeOnce = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorBody(error: unknown): Record<string, unknown> {
  if (error instanceof DshRpcError) {
    return { error: error.name, code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof DshTransportError) {
    return { error: error.name, code: "host_unreachable", message: error.message };
  }
  if (error instanceof PendingInteractionError) {
    return { error: error.name, code: error.code, message: error.message };
  }
  if (error instanceof EventLedgerError) {
    return { error: error.name, code: error.code, message: error.message, details: error.details };
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
    const details = "details" in error ? { details: error.details } : {};
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

export function createMcpServer(service: BridgeService): McpServer {
  const server = new McpServer({ name: "dsh-agentlink", version: "0.1.0-alpha.1" });

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
        "Create a root session on the configured official DSH Web Host and queue the initial prompt. Uses DSH's configured model; no model argument is accepted. Detached by default.",
      inputSchema: z
        .object({
          prompt: z.string().min(1),
          cwd: z.string().min(1).describe("Existing absolute directory visible to the DSH Host."),
          agentPreset: z.string().min(1).optional(),
          title: z.string().min(1).optional(),
          sessionId: z.string().min(1).optional().describe("Existing DSH root session id to reuse instead of creating a new one."),
          waitSeconds: z.number().int().min(0).max(30).default(0),
          workspaceMode: z.enum(["read-only", "exclusive-write"]).default("exclusive-write"),
        })
        .strict(),
      annotations: writeOnce,
    },
    async ({ prompt, cwd, agentPreset, title, sessionId, waitSeconds, workspaceMode }) =>
      handled(() =>
        service.delegate({
          prompt,
          cwd,
          waitSeconds,
          workspaceMode,
          ...(agentPreset === undefined ? {} : { agentPreset }),
          ...(title === undefined ? {} : { title }),
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
      ),
  );

  const followupSchema = z
    .object({
      taskId: taskIdSchema,
      prompt: z.string().min(1),
      mode: z.enum(["queue", "steer"]).default("queue"),
      sinceCursor: z.number().int().min(0).optional(),
      expectedRevision: z.number().int().min(0).optional(),
    })
    .strict();
  const followupDescription =
    "Continue the same root DSH session. queue targets the next turn; steer targets the active turn's next step. The write is never automatically retried.";
  server.registerTool(
    "dsh_followup",
    { description: followupDescription, inputSchema: followupSchema, annotations: writeOnce },
    async ({ taskId, prompt, mode, sinceCursor, expectedRevision }) =>
      handled(() => service.continueTask(taskId, prompt, mode, writePreconditions(sinceCursor, expectedRevision))),
  );
  server.registerTool(
    "dsh_continue",
    { description: `Compatibility alias for dsh_followup. ${followupDescription}`, inputSchema: followupSchema, annotations: writeOnce },
    async ({ taskId, prompt, mode, sinceCursor, expectedRevision }) =>
      handled(() => service.continueTask(taskId, prompt, mode, writePreconditions(sinceCursor, expectedRevision))),
  );

  server.registerTool(
    "dsh_status",
    {
      description:
        "Return separate availability/execution state, root and descendant sessions, queue depths, pending interactions, final message, and bridge cursor/watermarks.",
      inputSchema: z.object({ taskId: taskIdSchema }).strict(),
      annotations: readOnly,
    },
    async ({ taskId }) => handled(() => service.status(taskId)),
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
          maxEvents: z.number().int().min(1).max(500).default(50),
          maxBytes: z.number().int().min(1_024).max(1_000_000).default(64_000),
        })
        .strict(),
      annotations: readOnly,
    },
    async ({ taskId, sinceCursor, maxEvents, maxBytes }) =>
      handled(() => service.tail(taskId, sinceCursor, maxEvents, maxBytes)),
  );

  server.registerTool(
    "dsh_wait",
    {
      description:
        "Wait at most 30 seconds for a new task cursor, status/availability change, terminal state, or pending interaction. It never waits for whole-task completion.",
      inputSchema: z
        .object({
          taskId: taskIdSchema,
          timeoutSec: z.number().int().min(0).max(30).default(30),
          sinceCursor: z.number().int().min(0).optional(),
        })
        .strict(),
      annotations: readOnly,
    },
    async ({ taskId, timeoutSec, sinceCursor }) => handled(() => service.wait(taskId, timeoutSec, sinceCursor)),
  );

  server.registerTool(
    "dsh_observe",
    {
      description: "Compatibility observation alias. Prefer dsh_wait plus dsh_tail task cursors.",
      inputSchema: z
        .object({
          taskId: taskIdSchema,
          afterCursor: z.number().int().min(0).optional(),
          waitSeconds: z.number().int().min(0).max(30).default(0),
        })
        .strict(),
      annotations: readOnly,
    },
    async ({ taskId, afterCursor, waitSeconds }) => handled(() => service.observe(taskId, afterCursor, waitSeconds)),
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
      description: "List bridge task mappings enriched with current derived DSH status when the Host is reachable.",
      inputSchema: z.object({}).strict(),
      annotations: readOnly,
    },
    async () => handled(() => service.listTasks()),
  );

  server.registerTool(
    "dsh_release_workspace",
    {
      description:
        "Explicitly release this bridge task's persistent workspace claim. This does not close the DSH session or stop Web/Codex from editing the directory.",
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
        "Resolve one pending DSH sandbox-escalation approval as allow_once or reject. Never auto-allows; configure this Codex MCP tool with approval_mode=prompt before permitting allow_once.",
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
    },
    async ({ taskId, requestId, outcome, sinceCursor, expectedRevision }) =>
      handled(() => service.resolveApproval(taskId, requestId, outcome, writePreconditions(sinceCursor, expectedRevision))),
  );

  return server;
}
