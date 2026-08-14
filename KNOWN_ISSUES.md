# Known issues

## Shared coordination ledger can fail on a duplicate cursor

Status: open in `0.1.0-alpha.1`.

A duplicate task cursor has been observed when multiple bridge processes, including processes from different builds, shared the same `DSH_BRIDGE_HOME`. The affected task ledger then reported `unrecoverable_gap`; in the observed run, the rejected ledger queue also caused the MCP transport process to exit.

The exact concurrency path is still under investigation. Do not assume that the current inter-process lock fully protects mixed-version or overlapping bridge processes.

Until this is fixed:

- after upgrading, close or restart every Codex task that still runs the previous bridge build;
- do not run different DSH Orchestrator builds against the same `DSH_BRIDGE_HOME`;
- give concurrently active build or instance groups separate `DSH_BRIDGE_HOME` directories;
- preserve a failed bridge home for diagnosis instead of deleting it blindly; use a fresh bridge home to resume new delegations.

DSH conversation history remains owned by the DSH Web Host. Using a fresh bridge home does not delete DSH sessions, but existing bridge task ids, workspace claims, and task cursors are not automatically migrated.
