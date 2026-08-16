# Repository guidance

dsh-Agentlink is a caller-side, connect-only bridge to a user-managed DeepSeek Harness Web Host. Keep the shared Runtime caller-neutral: caller integrations configure and describe the same MCP Runtime instead of copying its task, event, approval, or recovery logic.

## Code Review Rules

### Host ownership and network exposure

- Flag any change that starts, stops, daemonizes, upgrades, or reconfigures `dsh web`, or that makes a non-loopback Host usable without the existing explicit opt-in. The safe path is to connect to the user-managed Host, report unavailability, and leave Host lifecycle decisions to the user.

### Conversation data and approvals

- Flag any persisted bridge state, local diagnostic file, or log that writes prompts, assistant messages, tool arguments or results, question bodies, approval bodies, credentials, or tokens. Persist only content-free coordination metadata and pointers; live supervision responses may hydrate necessary content from DSH session history without storing it locally.
- Flag any path that automatically allows a DSH approval or treats an agent as the final approver for a sandbox escape. `allow_once` must remain behind the supervising human boundary; timeout and unsupported cases fail closed.

### Shared runtime and live authority

- Flag caller-specific copies of `BridgeService`, the DSH event/state machine, ledger, or a new default state home without an explicit migration design. All caller packs must enter the shared Runtime and preserve cross-process/cross-caller recovery semantics.
- Flag mutations based only on cached session state, or changes that can drop/duplicate durable cursor events across reconnects and concurrent bridge processes. Re-read live Host state before mutations, preserve explicit `stale_view` behavior, and require a focused regression test for any changed recovery or concurrency invariant.
