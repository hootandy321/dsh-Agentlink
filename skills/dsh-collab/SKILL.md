---
name: dsh-collab
description: Delegate bounded coding tasks to the local DeepSeek Harness (DSH) Web Host via dsh-agentlink MCP tools. Use when a task is large, long-running, or needs DSH's sandbox and session history — keeping the supervisor in ZCode alongside.
description_i18n:
  zh-CN: "通过 dsh-agentlink MCP 工具将编码任务委托给本地 DeepSeek Harness (DSH) Web Host。当任务规模大、耗时长或需要 DSH 沙箱与会话历史时，在 ZCode 保持监督并行。"
---

# DSH Collaboration

This skill operates the `dsh-agentlink` MCP bridge connecting ZCode to your local DSH Web Host. The bridge is **connect-only**: it never starts, daemonizes, stops, or reconfigures `dsh web`. The Host lifecycle is managed by you or your OS service.

## Tool Names

In ZCode, MCP tools are exposed as `mcp__dsh_agentlink__<tool>`.

## Workflow

1. Call `mcp__dsh_agentlink__dsh_host_status` when Host availability is unknown. If unreachable, report the doctor/start command; do not start the Host yourself.
2. Call `mcp__dsh_agentlink__dsh_delegate` with a complete prompt and an existing absolute `cwd`. The `sessionId` parameter is optional — omit it to create a fresh session, or pass an existing session ID to continue a previous conversation. Use the default `exclusive-write` workspace claim for edits; use `read-only` only for non-mutating work. Keep the returned `taskId` and `rootSessionId`.
3. Treat BridgeTask, root session, and turn as distinct objects. A completed turn can be followed by another turn in the same root session.
4. Use `mcp__dsh_agentlink__dsh_wait` for at most 30 seconds, then `mcp__dsh_agentlink__dsh_tail` with `nextCursor`. Do not poll raw per-session seq values or assume mux `since` resumes history.
5. Before a write, retain the latest task `cursor` and connection `revision`, then pass them as `sinceCursor` and `expectedRevision`. Inspect `stale_view` changes instead of blindly retrying. Use `mcp__dsh_agentlink__dsh_followup(mode="queue")` for a later turn; use `mode="steer"` only when guidance must enter the active turn's next step.
6. Inspect `mcp__dsh_agentlink__dsh_status.pendingInteractions`. `dsh_followup` is not an answer channel.
7. Answer questions only with `mcp__dsh_agentlink__dsh_answer_question` and the exact pending request id and typed answers. Never infer sensitive credentials, publishing, or release answers.
8. Treat every approval as sandbox escalation. Never auto-allow. Use `mcp__dsh_agentlink__dsh_resolve_approval(..., outcome="allow_once")` only after the supervising user/ZCode approval boundary; `reject` is the fail-closed response.
9. Use `mcp__dsh_agentlink__dsh_cancel(scope="turn")` to cancel only the active turn while preserving queue. Use `scope="queue"` only with a current queue snapshot and expect a non-atomic per-item result.
10. Independently inspect DSH-produced files and test evidence before accepting the work. When collaboration is over, call `mcp__dsh_agentlink__dsh_release_workspace`; this does not close the DSH session.

## Interpretation Rules

- Read availability and execution separately. `host_unreachable` or `session_not_found` must not be relabeled as task failure; retain `lastKnownExecutionStatus`.
- `turn_completed` is not task deletion. A later follow-up reuses the root session.
- Task cursors are bridge-local merge order, not DSH global causality. Delivery is at-least-once with deterministic per-session seq dedupe.
- DSH `session.history` is the only conversation-content source. Bridge files contain mappings, claims, cursors, lineage, watermarks, rpcIds, pending/queue state without bodies, and final-message pointers only.
- Stop and report `cursor_expired`, `unrecoverable_gap`, or `terminal_missing_final`; never silently skip or return an empty successful final answer.
- Pending questions/approvals are live Host envelopes keyed by stable rpcId and are not persisted with their text.
- `dsh_cancel(scope="turn")` does not kill DSH background jobs. Third-party tools must honor AbortSignal; use DSH job controls for background work.
- Host restarts lose process-local active/pending/queue/job state. Do not promise seamless recovery.
- A workspace claim is cooperative, persistent across turn completion, and shared only by bridge processes using the same bridge home.
- If the `sessionId` was provided to `dsh_delegate`, the returned `rootSessionId` will match that value and no new session is created.

## Prerequisites

- A running DSH Web Host (e.g., `dsh web --profile web --port 3080`)
- Node.js 22+ installed
- dsh-Agentlink built (run `npm run build` in the repository root)
- The MCP server registered in ZCode config with `DSH_HOST_URL` set to your Host's address
