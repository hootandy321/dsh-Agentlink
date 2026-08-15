# Known issues

## Shared coordination ledger can fail on a duplicate cursor

Status: fixed after `0.1.0-alpha.1` (not yet released).

A duplicate task cursor was observed when multiple bridge processes, including processes from different builds, shared the same `DSH_BRIDGE_HOME`. The affected task ledger then reported `unrecoverable_gap`; in the observed run, the rejected ledger queue also caused the MCP transport process to exit.

The root cause included two unsafe check-then-delete paths. A process that lost the race between creating a lock directory and writing its `owner.json` could delete a replacement lock. Separately, automatic stale-lock reaping could rename and delete a freshly reacquired lock based on an older mtime/PID observation.

The fixed implementation retries owner writes that lose with `ENOENT` or `EEXIST` without deleting the current lock directory. After a failed `mkdir`, an unexpected owner-write error never removes the current path: the process cannot prove that the still-empty directory is its own attempt (a competitor may have replaced it before writing its `owner.json`), so it fails closed and leaves the path untouched. Automatic stale reaping is disabled and fails closed because Node's portable filesystem APIs cannot atomically compare a stale observation with a later destructive rename. Deterministic regression tests cover lost owner writes, stale observations, preservation of competing owners, and preservation of a competitor's still-empty replacement directory. The doctor does not try to diagnose those historical race paths; it reports only the currently observed state of the known lock locations, and it does so read-only.

Upgrade requirement: every bridge process sharing one `DSH_BRIDGE_HOME` must be restarted onto the fixed build. One remaining `0.1.0-alpha.1` process can still race with a fixed process because the old process does not follow the corrected ownership rules.

When upgrading or recovering an affected installation:

- close or restart every Codex task that still runs the previous bridge build;
- do not run different dsh-Agentlink builds against the same `DSH_BRIDGE_HOME`;
- give concurrently active build or instance groups separate `DSH_BRIDGE_HOME` directories;
- preserve a failed bridge home for diagnosis instead of deleting it blindly; use a fresh bridge home to resume new delegations.

DSH conversation history remains owned by the DSH Web Host. Using a fresh bridge home does not delete DSH sessions, but existing bridge task ids, workspace claims, and task cursors are not automatically migrated.

### Crash-recovery trade-off

The lock is intended for short critical sections on one local filesystem. It has no heartbeat, its PID/mtime observations are not valid on NFS, and the fixed build does not automatically delete an apparently stale lock. A process that is hard-killed while holding a lock can therefore leave an exact lock directory that causes later operations to time out. Stop every bridge process using that bridge home, preserve a backup, and inspect the exact owner before any manual cleanup; never delete the bridge home or a broad parent directory blindly.

### Doctor reports fail-closed locks read-only and never cleans them

`npm run doctor` reports only the currently observed structure of each known fail-closed lock location under the bridge home — `claims/registry.lock` and `ledgers/<valid task id>/events.lock`. It reports path/owner presence and filesystem type plus bounded entry observations. It never opens or parses `owner.json`, and never reports its pid, token, `createdAt`, or other contents. These are point-in-time observations, not race-proof ownership or liveness conclusions. Both the ledgers scan and each lock-directory scan stop after a bounded max-plus-one observation and explicitly report truncation. The doctor never creates, deletes, renames, chmods, rewrites, or acquires a lock, never declares one safe to delete, and never auto-cleans one.

### Existing large ledgers are not compacted by this patch

The patch prevents new top-level `session/projection` snapshots and high-frequency assistant stream chunks from inflating the durable ledger; `session/jobs` remains durable, with its payload scrubbed by the existing coordination-only rules. It does not rewrite or compact an existing 5 MB+ ledger. Preserve the old bridge home for inspection. New delegations may use a separate `DSH_BRIDGE_HOME`, but its task ids, cursors, and claims start fresh. DSH `session.history` remains the conversation source of truth; changing bridge home does not delete Host sessions. No automatic cleanup command is provided.
