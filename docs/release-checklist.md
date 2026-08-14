# DSH Orchestrator release checklist

## Positioning

Recommended repository description:

> Codex-side MCP collaboration bridge for the official DeepSeek Harness Web Host, with observable sessions, follow-up, cancellation, and human-gated approvals.

Recommended GitHub topics:

- `dsh-plugin`
- `deepseek-harness`
- `dsh`
- `codex`
- `mcp`
- `agent-collaboration`

`dsh-plugin` is used here in the broad ecosystem/discovery sense. The README must retain the prominent statement that this repository is a standalone companion bridge, does not declare `dsh.bundle`, and is not installed with `dsh plugin add`.

## Before making the repository public

- Confirm that the `LICENSE` file and `package.json` both identify the MIT License.
- Confirm that the GitHub owner and repository metadata still match `hootandy321/dsh-orchestrator`.
- Confirm that `node_modules/`, `dist/`, `.DS_Store`, `.env` files, logs, tarballs, and local bridge state are not tracked.
- Search for credentials, private keys, tokens, personal absolute paths, internal hosts, and real session identifiers.
- Run `npm ci`, `npm run check`, and `npm pack --dry-run` from a clean checkout.
- Run the live acceptance procedure in [`validation.md`](validation.md) against the exact DSH version named in the README.
- Enable GitHub private vulnerability reporting if available.
- Set the recommended topics and repository description.

## Distribution boundary

The initial release is a GitHub source release. `package.json` remains `private: true` until npm publication is deliberately approved and the package name, license, ownership metadata, and release process are finalized.

Do not advertise this command for the current repository:

```text
dsh plugin --profile <name> add github:<owner>/dsh-orchestrator
```

A future native DSH bundle would need a meaningful Host-side capability, a `dsh.bundle.patch` manifest, `cordis.patch.yml`, a Cordis entrypoint, compatibility tests, and its own documented security boundary. An empty wrapper added only to qualify for a topic is not sufficient.
