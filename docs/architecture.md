# Architecture and safety model

**English** | [简体中文](architecture.zh-CN.md)

This document contains the bridge semantics that are intentionally kept out of the user-facing README. It describes the current `0.1.0-alpha.1` behavior, not a permanent compatibility promise.

## Positioning and Host lifecycle

dsh-Agentlink is a caller-side bridge, not a DSH Cordis bundle. Codex starts it as a local STDIO MCP server; the bridge connects to an independently running official DSH Web Host.

The bridge is connect-only. It does not start, daemonize, stop, or own `dsh web`, and it has no Host pidfile or port lock. The user or an OS service owns the Host lifecycle. This keeps DSH sessions visible through the official Web UI after an individual Codex MCP process exits.

## Identity and state model

A BridgeTask, a DSH root session, and a DSH turn are different objects:

- One BridgeTask has one stable `taskId -> rootSessionId` identity mapping.
- The root session can run many turns; `turn_completed` does not remove the task or prevent another follow-up.
- Session-backed DSH subagent descendants are discovered from `session.list`/`subagent.list`, reconciled independently, and retain `parentSessionId` plus `origin="subagent"` in the task ledger.

Status does not collapse connectivity and execution into one enum:

- `availability`: `connected | host_unreachable | session_not_found`
- `execution`: `starting | running | awaiting_approval | awaiting_input | turn_completed | failed | canceled | interrupted`
- Public `status` is `unknown` when availability overrides the current execution observation, while `lastKnownExecutionStatus` is retained.

Queue depth is derived from the latest complete `session/queue` snapshot:

- `nextTurn`: `placement="queued"`
- `steering`: `placement="steering"`
- `context`: `placement="context"`
- `nextStep`: steering plus context
- `total`: all pending items

Queue state is marked stale or unknown as soon as `events.mux` disconnects.

## Event ledger and recovery

DSH session/history is the only source of truth for conversation content. The bridge does not copy prompts, user or assistant text, tool arguments/results, or question bodies into its files. It persists only coordination state in three separate stores:

1. `tasks/<taskId>.json` contains only `{taskId, sessionId}`.
2. `claims/<taskId>.json` contains the canonical cwd, task/session owner, claim mode, and creation time.
3. `ledgers/<taskId>/events.jsonl` is a rebuildable coordination index for task cursors, lineage, source watermarks, non-content execution/pending state, issued rpcIds, and final-message pointers.

Each JSONL record has a monotonic task `cursor`/`mergeIndex`, `sourceSessionId`, optional `sourceSeq`, optional `parentSessionId`, `origin`, event type, and a scrubbed `coordination` object. It never contains the full mux/history envelope. `mergeIndex` is bridge observation and persistence order, not a DSH global causal order.

Task-ledger appends and workspace-claim changes use task/registry-scoped inter-process locks. A writer rereads current disk state while holding the lock before allocating a cursor or changing a claim. Immutable task mappings use atomic temp-file plus hard-link creation. Bridge processes sharing one `DSH_BRIDGE_HOME` therefore share coordination state and must point to the same Host. Use a separate bridge home when changing Host origins. Lock critical sections are short and local-filesystem only; automatic stale-lock reaping is deliberately disabled because PID/mtime observation cannot be atomically coupled to a destructive rename. A hard-killed writer can leave a fail-closed lock that requires explicit operator recovery.

Recovery is subscribe-first:

1. Open `events.mux` and buffer live frames.
2. Read each `session/subscribed.lastSeq` watermark, or use the open stream as the fence for cold sessions.
3. Page `session.history`/`subagent.history` backwards to the persisted per-session high-watermark.
4. Sort and deterministically deduplicate durable events by `(sourceSessionId, sourceSeq)`.
5. Drain buffered live frames, then expose the committed task cursor.

rc.6 ignores `events.mux.since`; it is not a durable backlog. Delivery is documented as **at-least-once with deterministic dedupe**, never exactly-once. A gap that cannot be reconstructed is returned as `unrecoverable_gap`; an obsolete cursor is `cursor_expired` with `earliestCursor`. The bridge does not silently skip either condition.

`dsh_tail` returns bounded digests and `nextCursor`. While the Host is connected, it resolves source pointers from `session.history` at call time: assistant chunks are omitted or compacted, tool output is reduced, and questions, approvals, errors, turn outcomes, and the final assistant message remain complete in the response only. When the Host is unavailable, it returns `contentUnavailable` instead of reconstructing conversation text from a bridge copy.

At each root `turn/end`, the ledger folds only the last user-visible `assistant/message` pointer (`sessionId + seq`); `dsh_status` resolves that pointer from live history. A terminal turn with no pointer reports `terminal_missing_final`, not successful empty output.

The event pump runs even when no caller is tailing. After bridge restart, it rebuilds coordination folds from JSONL and reconciles them against authoritative DSH history. It never rebuilds content from bridge files.

## Questions and approvals

`dsh_followup` cannot answer a pending DSH interaction. The bridge continuously consumes `events.mux` and keeps a per-rpcId pending map in memory. While connected, current requested frames are returned verbatim in `dsh_status` and `dsh_tail`; question text is never persisted.

On reconnect, rc.6 replays still-pending requests with stable rpcIds. After the mux baseline quiet period, absent prior requests receive coordination tombstones so they cannot silently revive; a later valid replay reopens the item. This is an explicit rc.6 heuristic capability, not a Host transaction.

Only typed response tools are public:

- `dsh_answer_question(taskId, requestId, answers[])`
- `dsh_resolve_approval(taskId, requestId, outcome="allow_once"|"reject")`

They validate the rpcId type, task/session lineage, question ids, order, and options, then issue exactly one non-retried `POST /api/respond` client response. The Host carrier receipt is authoritative: `bad-response` keeps the item pending; `not-pending` means it was already answered, canceled, raced, or expired.

Safety rules:

- The bridge never automatically allows an approval.
- Every `approval/requested` is treated as a DSH sandbox escalation.
- `allow_once` maps only to wire outcome `allowed-once`; it is not a persistent policy change.
- A configured timeout is only one best-effort reject while this process and connection are alive. It is not a Host-level guarantee.
- For unattended fail-closed operation, configure DSH approval policy `never`; absence of an answerer remains fail-closed.
- Questions are shown verbatim and are never automatically answered on the user's behalf, especially for credentials, publishing, releases, or other sensitive actions.

## Follow-up and cancellation semantics

`dsh_followup(mode="queue")` targets DSH `next-turn`; `mode="steer"` targets `next-step`. Queue can start a later turn after the current turn ends. Steer enters the active turn at the next step. Neither write is automatically retried.

Every session mutation performs a fresh `session.list`/history reconciliation first. Follow-up also reads live `session.models` and reports the actual current route. Mutation tools accept optional `sinceCursor` and `expectedRevision`. If the reconciled view differs, the bridge returns `stale_view` with the observed changes instead of issuing the write.

The unary rpcId generated for each bridge prompt is retained as coordination metadata. A matching `user/message.data.source.rpcId` is marked `initiatedBy="bridge"`; unmatched messages are `external_or_unknown`. This is a freshness check, not a transaction: DSH Web can still race between preflight and the write.

`dsh_cancel(scope="turn")` calls rc.6 `session.cancel`. It cancels only the active root turn with queued inbox work preserved. Built-in foreground shell tools use cooperative abort and escalate the foreground process group from SIGTERM to SIGKILL after about three seconds, but:

- `run_in_background` jobs are not killed by that turn signal and require DSH `job_kill`.
- Third-party tools are cancellable only when they honor `AbortSignal`.

`dsh_cancel(scope="queue")` consumes the current mux queue snapshot and issues one `session.updateQueue(remove)` per item id. It is non-atomic. The result separates `requested`, `removed`, `alreadyClaimed`, and `failed`; it never promises all-or-nothing queue clearing.

## Workspace coordination

`dsh_delegate` resolves the requested cwd through `realpath` and acquires a persistent workspace claim. The default is `exclusive-write`; `read-only` permits overlapping read-only tasks, while any overlapping ancestor or descendant exclusive claim conflicts. Claims are shared across bridge processes using the same bridge home and remain after `turn/end`, because a person can continue the session later from DSH Web.

Release a claim only with `dsh_release_workspace`. Release does not close or cancel the DSH session. Follow-up, question answers, and `allow_once` require the task's claim to remain active; safety cancellation and approval rejection stay available without it.

The claim is cooperative. It prevents conflicting delegations seen by this bridge store, but cannot stop DSH Web, another bridge home, Codex, a shell, or an editor from writing files. The supervising Codex process must not edit an exclusively claimed cwd. A dedicated git worktree per writable delegation is the recommended strong isolation boundary.

If claim acquisition races after DSH session creation, the bridge returns a conflict identifying the unprompted session/task mapping; it does not silently run without a claim.

## Explicit limitations

- No Host process lifecycle management, authentication layer, pidfile, port lock, or automatic Host start.
- No automatic retry of non-idempotent writes (`session.create`, prompt/follow-up, cancel, queue mutation, `/api/respond`).
- A WebSocket disconnect produces `host_unreachable`/unknown, not task failure; read-only reconnect/history recovery continues automatically.
- Host restart loses its process-local active turn, pending interactions, queue, and background-job state. The bridge does not claim seamless continuation.
- If fresh history still ends at `turn/start` but fresh `session.list` says the session is no longer running, status records a content-free `interrupted` coordination marker. A later durable `turn/end` supersedes it during reconciliation.
- DSH durable session/history can survive a Host restart, but a created-only zero-event session may be lazily absent. The bridge process-restart mock test uses a session with durable events; no live rc.6 restart was performed by the implementation run.
- Queue state is unknown after mux connect or reconnect until rc.6 emits an actual `session/queue` snapshot. The bridge does not infer an empty queue from `session/subscribed`.
- Ordinary user-created session forks are not folded into a BridgeTask; session-backed subagent descendants are.
- Host-origin affinity is configuration-scoped rather than stored in the strict task mapping. Do not reuse one `DSH_BRIDGE_HOME` after changing `DSH_HOST_URL`; per-task cross-Host migration is unsupported.
- Workspace claims do not provide OS-level exclusion, and fresh write preflight cannot eliminate a Web-client time-of-check/time-of-use race. Full simultaneous multi-Codex plus interactive-Web conflict freedom is not claimed.
- Exactly-once delivery, atomic queue clear, `events.mux.since` resume, argument-dependent Codex approval policy, automatic background-job cancellation, and Host-package detection through `host.describe.version` are unsupported.
- Real browser-visible end-to-end interaction is an operator acceptance step, not part of `npm test`. Follow the [validation guide](validation.md) after changing DSH, the model route, the agent preset, or bridge transport behavior.

See [Known issues](../KNOWN_ISSUES.md) for current source-preview defects and operational workarounds.
