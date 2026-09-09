# Validation guide

This guide separates repeatable automated checks from operator-observed integration evidence.

## Automated checks

From a clean checkout:

```bash
npm ci
npm run check
npm pack --dry-run
```

The unit tests use mock DSH hosts. They cover bridge state, cursor recovery, event reduction, questions and approvals, cancellation, workspace claims, process reconnection, and MCP schemas without requiring a live model route.

## Live Host preflight

Start `dsh web` separately under user or OS-service ownership, then run:

```bash
npm run doctor
```

Record, without credentials or session content:

- `dsh --version`;
- `host.describe.version` and the fact that it may be a product placeholder;
- probed Host capabilities;
- configured model provider/model and `routable` state;
- bridge commit or release tag;
- operating system and Node.js version.

## Browser-visible acceptance

1. Open the same DSH Web Host used by the bridge.
2. Delegate a task with `workspaceMode="read-only"` in a disposable workspace and keep its task/session identifiers private. Confirm the response reports `workspaceClaimSemantics.controlsDshSandbox=false`; this is a bridge-local claim, not a DSH sandbox assertion.
3. Confirm that the root session appears in DSH Web.
4. Confirm that `dsh_wait` and cursor-based `dsh_tail` observe progress without dropping or duplicating the terminal event.
5. Confirm that `dsh_status` reaches `turn_completed` and returns the final message from live DSH history.
6. Send one follow-up to the same task and confirm that it creates another turn in the same root session.
7. If a harmless test can produce a typed question, answer it through `dsh_answer_question` and confirm that an ordinary follow-up does not resolve it.
8. Do not manufacture a sandbox escape only to test approval forwarding. When a legitimate approval occurs, verify that it is never auto-allowed and that rejection remains available.
9. Release the workspace claim and confirm that the DSH session remains visible.

Repeat this acceptance after changing the DSH version, Web API behavior, model route, agent preset, event reconciliation, or mutation semantics.

## Evidence boundary

A passing unit suite does not prove live Host compatibility. One live success proves only the recorded DSH version, route, preset, workspace, and bridge revision. Host-restart durability requires a separate test and must not be inferred from bridge-process reconnection.
