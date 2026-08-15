# Known issues

## Shared coordination ledger can fail on a duplicate cursor

Status: fixed after `0.1.0-alpha.1` (not yet released).

A duplicate task cursor was observed when multiple bridge processes, including processes from different builds, shared the same `DSH_BRIDGE_HOME`. The affected task ledger then reported `unrecoverable_gap`; in the observed run, the rejected ledger queue also caused the MCP transport process to exit.

The root cause was a race between creating a lock directory and writing its `owner.json`. If another process removed or replaced the directory in that window, the losing writer could delete the replacement lock. A second stale-lock race treated a vanished directory as proof that a subsequently created lock was stale.

The fixed implementation retries owner writes that lose with `ENOENT` or `EEXIST` without deleting the current lock directory, and treats `stat` `ENOENT` as a non-stale observation. Deterministic regression tests cover both races and preservation of the competing owner.

Upgrade requirement: every bridge process sharing one `DSH_BRIDGE_HOME` must be restarted onto the fixed build. One remaining `0.1.0-alpha.1` process can still race with a fixed process because the old process does not follow the corrected ownership rules.

When upgrading or recovering an affected installation:

- close or restart every Codex task that still runs the previous bridge build;
- do not run different dsh-Agentlink builds against the same `DSH_BRIDGE_HOME`;
- give concurrently active build or instance groups separate `DSH_BRIDGE_HOME` directories;
- preserve a failed bridge home for diagnosis instead of deleting it blindly; use a fresh bridge home to resume new delegations.

DSH conversation history remains owned by the DSH Web Host. Using a fresh bridge home does not delete DSH sessions, but existing bridge task ids, workspace claims, and task cursors are not automatically migrated.
