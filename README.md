# DSH Orchestrator

![DSH Orchestrator cover](assets/dsh-orchestrator-cover.png)

A community-maintained orchestration bridge from Codex to the **official DeepSeek Harness (DSH) Web Host**. It exposes supervised DSH collaboration as a local STDIO MCP server. Sessions are created through the same Host, so DSH Web and Codex operate on the same DSH session registry.

> [!IMPORTANT]
> This is currently a **Codex-side companion integration**, not a DSH Cordis bundle. The repository uses `dsh-plugin` in the broad ecosystem sense, but it does not declare `dsh.bundle` or ship `cordis.patch.yml`. Do not install it with `dsh plugin --profile ... add ...`; install it as a Codex MCP server using the instructions below.

> [!WARNING]
> DSH is in developer preview and its APIs can change incompatibly. This bridge is independent community software and is not affiliated with or endorsed by DeepSeek or OpenAI.

> [!CAUTION]
> `0.1.0-alpha.1` is a source preview. A duplicate-cursor ledger failure has been observed when multiple bridge processes, including processes from different builds, share one `DSH_BRIDGE_HOME`. The exact concurrency root cause is still under investigation. Until it is fixed, close old bridge processes after upgrading and use a separate bridge home for each concurrently active build. See [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md).

```text
Codex -> local STDIO MCP bridge -> official dsh web Host <- browser
                                  |
                                  +-> DSH root session / turns / subagents
```

The bridge is connect-only. It never starts, daemonizes, stops, or owns `dsh web`; it has no pidfile or port lock. The user or an OS service owns the Host lifecycle.

## Requirements and startup

- Node.js 22 or newer
- DSH CLI `0.1.0-rc.6`, the current tested compatibility target
- An official Web Host, normally at `http://127.0.0.1:3080`

See the [official DSH repository](https://github.com/deepseek-ai/deepseek-harness) and [Harness site](https://www.deepseek.com/harness/en/) for DSH installation and plugin documentation.

Install and verify the bridge:

```bash
npm install
npm run build
npm test
npm run doctor
```

If doctor cannot connect, it prints an explicit command such as:

```bash
dsh web --host 127.0.0.1 --port 3080
```

Doctor prints the local `dsh --version` separately from `host.describe.version`. In rc.6, a live Host reports the placeholder product value `0.0.1`; that field is **not** the DSH CLI/package version and is never used as the compatibility gate. Compatibility is based on read-only capability probes (`host.describe`, `session.list`, WebSocket `events.mux`, and history when a session exists).

The long-running bridge cannot infer the CLI package version from the Host. `dsh_host_status` therefore marks the runtime version `untested` unless the operator declares `DSH_HOST_VERSION=0.1.0-rc.6`; any other declared version remains `untested` even when capability probes pass. `npm run doctor` is the command that independently executes `dsh --version` and reports `tested` versus `compatible-untested`.

## Codex MCP configuration

After building:

```toml
[mcp_servers.dsh_collab]
command = "node"
args = ["/absolute/path/to/dsh-orchestrator/dist/index.js"]
startup_timeout_sec = 10
tool_timeout_sec = 60

[mcp_servers.dsh_collab.env]
DSH_HOST_URL = "http://127.0.0.1:3080"
DSH_HOST_VERSION = "0.1.0-rc.6"
# Optional bridge-only default. `code` keeps the standard capability set but
# presents it through DSH Code Mode, which is well suited to implementation work.
DSH_BRIDGE_AGENT_PRESET = "code"

# A DSH approval is a sandbox escalation. Keep allow_once human-gated.
[mcp_servers.dsh_collab.tools.dsh_resolve_approval]
approval_mode = "prompt"
```

`dsh_wait` is capped at 30 seconds, below the normal 60-second MCP tool timeout, and never waits for an entire task to finish.

Environment variables:

- `DSH_HOST_URL` — official Web Host origin; default `http://127.0.0.1:3080`
- `DSH_HOME` — DSH home used to derive the bridge home; default `~/.dsh`
- `DSH_BRIDGE_HOME` — bridge task mappings, workspace claims, and coordination-index directory override
- `DSH_REQUEST_TIMEOUT_MS` — unary and WebSocket-connect timeout; default 30 seconds
- `DSH_BRIDGE_AGENT_PRESET` — optional bridge-only default installed DSH agent preset; omit it to follow DSH's own default. The shipped `code` preset retains standard capabilities through the Code Mode SDK. Callers may still select another installed preset per delegation.
- `DSH_BRIDGE_TIME_ZONE` — optional IANA time zone for human prompts
- `DSH_HOST_VERSION` — optional operator-declared package version; never inferred from `host.describe.version`
- `DSH_APPROVAL_TIMEOUT_MS` — disabled by default; while this bridge process is alive, make one best-effort `rejected` response after the timeout
- `DSH_ALLOW_REMOTE_HOST=true` — opt in to a non-loopback Host

rc.6 Web API has no auth token. The Host/Origin fence is not authentication. Loopback-only is therefore the default; a remote URL must be an explicitly trusted deployment.

## MCP tools

- `dsh_host_status` — connect-only Host state and capabilities
- `dsh_delegate` — create a root session and queue the initial prompt; detached by default (`waitSeconds=0`)
- `dsh_followup` — continue the same root session with explicit `mode="queue"|"steer"` (default `queue`)
- `dsh_continue` — compatibility alias for `dsh_followup`
- `dsh_status` — availability, execution, lineage, queue, pending interactions, final message, and cursors
- `dsh_tail` — bounded event digests using a bridge task cursor
- `dsh_wait` — wait up to 30 seconds for a new event/state/pending/terminal change
- `dsh_observe` — compatibility alias around `dsh_wait`; bridge cursors replace raw session seq cursors
- `dsh_cancel` — `scope="turn"|"queue"`
- `dsh_list` — task mappings enriched with current derived status
- `dsh_answer_question` — typed answer for a pending question rpcId
- `dsh_resolve_approval` — typed `allow_once|reject` response for a pending approval rpcId
- `dsh_release_workspace` — explicitly release a persistent bridge workspace claim without closing the DSH session

Normal delegation has no model argument. Configure the desired model only when installing or adjusting DSH. Each delegate reads `session.models.current` and trusts the Host's `routable` boolean; it neither changes the model nor derives routability from catalog groups.

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

Queue state is marked stale/unknown as soon as `events.mux` disconnects.

## Event ledger and recovery

DSH session/history is the only source of truth for conversation content. The bridge does not copy prompts, user or assistant text, tool arguments/results, or question bodies into its files. It persists only coordination state in three deliberately separate stores:

1. `tasks/<taskId>.json` contains **only** `{taskId, sessionId}`.
2. `claims/<taskId>.json` contains the canonical cwd, task/session owner, claim mode, and creation time.
3. `ledgers/<taskId>/events.jsonl` is a rebuildable coordination index for task cursors, lineage, source watermarks, non-content execution/pending state, issued rpcIds, and final-message pointers.

Each JSONL record has a monotonic task `cursor`/`mergeIndex`, `sourceSessionId`, optional `sourceSeq`, optional `parentSessionId`, `origin`, event type, and a scrubbed `coordination` object. It never contains the full mux/history envelope. `mergeIndex` is only bridge observation/persistence order; it is not a DSH global causal order.

Task ledger appends and workspace-claim changes use task/registry-scoped inter-process locks. A writer rereads current disk state while holding the lock before allocating a cursor or changing a claim. Immutable task mappings use atomic temp-file plus hard-link creation. Two bridge processes pointed at the same `DSH_BRIDGE_HOME` therefore share coordination state; they must also point at the same Host. Use a separate bridge home when changing Host origins.

Recovery is subscribe-first:

1. Open `events.mux` and buffer live frames.
2. Read each `session/subscribed.lastSeq` watermark (or use the open stream as the fence for cold sessions).
3. Page `session.history`/`subagent.history` backwards to the persisted per-session high-watermark.
4. Sort and deterministically deduplicate durable events by `(sourceSessionId, sourceSeq)`.
5. Drain buffered live frames, then expose the committed task cursor.

rc.6 ignores `events.mux.since`; it is not a durable backlog. Delivery is documented as **at-least-once with deterministic dedupe**, never exactly-once. A gap that cannot be reconstructed is returned as `unrecoverable_gap`; an obsolete cursor is `cursor_expired` with `earliestCursor`. The bridge does not silently skip either condition.

`dsh_tail` returns bounded digests and `nextCursor`. While the Host is connected, it resolves source pointers from `session.history` at call time: assistant chunks are omitted/compacted, tool output is reduced, and questions, approvals, errors, turn outcomes, and the final assistant message remain complete in the response only. When the Host is unavailable it returns `contentUnavailable` instead of reconstructing conversation text from a bridge copy. At each root `turn/end`, the ledger folds only the last user-visible `assistant/message` pointer (`sessionId + seq`); `dsh_status` resolves that pointer from live history. A terminal turn with no pointer reports `terminal_missing_final`, not successful empty output.

The event pump runs even when no caller is tailing. After bridge restart it rebuilds coordination folds from JSONL and reconciles them against authoritative DSH history. It never rebuilds content from the bridge files.

## Questions and approvals

`dsh_followup` cannot answer a pending DSH interaction. The bridge continuously consumes `events.mux` and keeps a per-rpcId pending map in memory. While connected, current requested frames are returned verbatim in `dsh_status` and `dsh_tail`; their question text is never persisted. On reconnect, rc.6 replays still-pending requests with stable rpcIds. After the mux baseline quiet period, absent prior requests receive coordination tombstones so they cannot silently revive; a later valid replay reopens the item. This is an explicit rc.6 heuristic capability, not a Host transaction.

Only typed response tools are public:

- `dsh_answer_question(taskId, requestId, answers[])`
- `dsh_resolve_approval(taskId, requestId, outcome="allow_once"|"reject")`

They validate the rpcId type, task/session lineage, question ids/order/options, and then issue exactly one non-retried `POST /api/respond` client-response. The Host's carrier receipt is authoritative: `bad-response` keeps the item pending; `not-pending` means it was already answered, cancelled, raced, or expired.

Safety rules:

- The bridge never automatically allows an approval.
- Every `approval/requested` is treated as a DSH sandbox escalation.
- `allow_once` maps only to wire outcome `allowed-once`; it is not a persistent policy change.
- A configured timeout is only one best-effort reject while this process and connection are alive. It is not a Host-level guarantee.
- For truly unattended fail-closed operation, configure DSH approval policy `never`; absence of an answerer remains fail-closed.
- Questions are shown verbatim and are never automatically answered on the user's behalf, especially for credentials, publishing, releases, or other sensitive actions.

## Follow-up and cancellation semantics

`dsh_followup(mode="queue")` targets DSH `next-turn`; `mode="steer"` targets `next-step`. Queue can start a later turn after the current turn ends. Steer enters the active turn at the next step. Neither write is automatically retried.

Every session mutation performs a fresh `session.list`/history reconciliation first; follow-up also reads live `session.models` and reports the actual current route. Mutation tools accept optional `sinceCursor` and `expectedRevision`. If the reconciled view differs, the bridge returns `stale_view` with the observed changes instead of issuing the write. The unary rpcId generated for each bridge prompt is retained as coordination metadata, so a matching `user/message.data.source.rpcId` is marked `initiatedBy="bridge"`; unmatched messages are `external_or_unknown`. This is a freshness check, not a transaction: DSH Web can still race between preflight and the write.

`dsh_cancel(scope="turn")` calls rc.6 `session.cancel`. It cancels only the active root turn with queued inbox work preserved. Built-in foreground shell tools use cooperative abort and escalate the foreground process group from SIGTERM to SIGKILL after about three seconds, but:

- `run_in_background` jobs are not killed by that turn signal and require DSH `job_kill`.
- Third-party tools are only cancellable when they honor `AbortSignal`.

`dsh_cancel(scope="queue")` consumes the current mux queue snapshot and issues one `session.updateQueue(remove)` per item id. It is non-atomic. The result separates `requested`, `removed`, `alreadyClaimed`, and `failed`; it never promises all-or-nothing queue clearing.

## Workspace coordination

`dsh_delegate` resolves the requested cwd through `realpath` and acquires a persistent workspace claim. The default is `exclusive-write`; `read-only` permits overlapping read-only tasks, while any overlapping ancestor/descendant exclusive claim conflicts. Claims are shared across bridge processes using the same bridge home and remain after `turn/end`, because a person can continue the session later from DSH Web.

Release a claim only with `dsh_release_workspace`. Release does not close or cancel the DSH session. Follow-up, question answers, and `allow_once` require the task's claim to remain active; safety cancellation and approval rejection stay available without it.

The claim is cooperative. It prevents conflicting delegations seen by this bridge store, but cannot stop DSH Web, another bridge home, or Codex/shell/file-editor writes. The supervising Codex process must not edit an exclusively claimed cwd. A dedicated git worktree per writable delegation is the recommended strong isolation boundary. If claim acquisition races after DSH session creation, the bridge returns a conflict identifying the unprompted session/task mapping; it does not silently run without a claim.

## Explicit limitations

- No Host process lifecycle management, auth layer, pidfile, port lock, or automatic Host start.
- No automatic retry of non-idempotent writes (`session.create`, prompt/follow-up, cancel, queue mutation, `/api/respond`).
- A WebSocket disconnect produces `host_unreachable`/unknown, not task failure; read-only reconnect/history recovery continues automatically.
- Host restart loses its process-local active turn, pending interactions, queue, and background-job state. The bridge does not claim seamless continuation.
- If fresh history still ends at `turn/start` but fresh `session.list` says the session is no longer running, status records a content-free `interrupted` coordination marker instead of continuing to report `running`; a later durable `turn/end` supersedes it during reconciliation.
- DSH's durable session/history can survive a Host restart, but a created-only zero-event session may be lazily absent. The bridge process-restart mock test uses a session with durable events; no live rc.6 restart was performed by this implementation run.
- Queue state is unknown after mux connect/reconnect until rc.6 emits an actual `session/queue` snapshot. The bridge never infers an empty queue merely from `session/subscribed`.
- Ordinary user-created session forks are not folded into a BridgeTask; session-backed subagent descendants are.
- Host-origin affinity is configuration-scoped rather than stored in the strict task mapping. Do not reuse one `DSH_BRIDGE_HOME` after changing `DSH_HOST_URL`; per-task cross-Host migration is unsupported.
- Workspace claims cannot provide OS-level exclusion and fresh write preflight cannot eliminate a Web-client time-of-check/time-of-use race. Full simultaneous multi-Codex plus interactive-Web conflict freedom is not claimed.
- Exactly-once delivery, atomic queue clear, `events.mux.since` resume, argument-dependent Codex approval policy, automatic background-job cancellation, and Host-package detection through `host.describe.version` are unsupported.
- Real browser-visible end-to-end interaction is an operator acceptance step, not part of `npm test`. Follow [`docs/validation.md`](docs/validation.md) after changing DSH, the model route, the agent preset, or bridge transport behavior.

## Contributing and release status

- Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before proposing changes.
- Report security issues according to [`SECURITY.md`](SECURITY.md); do not put credentials or sensitive session content in a public issue.
- Review [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) before running more than one bridge process or upgrading an active installation.
- The public-repository checklist and recommended GitHub topics are in [`docs/release-checklist.md`](docs/release-checklist.md).
- This source preview is licensed under the [`MIT License`](LICENSE). npm publication remains disabled by `private: true` until a separate package-release decision is made.
