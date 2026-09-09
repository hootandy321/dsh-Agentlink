# Compatibility matrix

This page records which DSH versions dsh-Agentlink has actually been tested against. Version records are diagnostic evidence, not a runtime gate; the bridge gates on capability probes, not on version strings.

## Tested compatibility targets

| DSH CLI/Host version | Status | Evidence date |
|---|---|---|
| `0.1.0-rc.6` | tested | 2026-08 |
| `0.1.0-rc.7` | tested | 2026-08-19 |

Any other version reports `compatible-untested` when capability probes pass, or `untested` from the long-running bridge until `DSH_HOST_VERSION` is declared with a tested value.

## rc.7 evidence (2026-08-19)

- Wire surface: the eleven RPC methods the bridge uses (`host.describe`, `session.list`, `session.create`, `session.history`, `session.models`, `session.prompt`, `session.rename`, `session.cancel`, `session.updateQueue`, `subagent.list`, `subagent.history`) are unchanged between the published rc.6 and rc.7 packages; `events.mux` and `/api/respond` are likewise unchanged.
- Live probes against a real rc.7 Host (`@deepseek-ai/dsh@0.1.0-rc.7 web`, loopback): `host.describe`, `session.list`, `events.mux` WebSocket open, and `session.history` all passed `npm run doctor`.
- Live acceptance: one read-only delegation in a disposable workspace against the rc.7 Host completed the full loop — model route read (`routable` verified), `turn_completed` reached, final message resolved from live history, cursor tail delivered all events without gaps, workspace claim released.
- Unit suite: 131/131 at the bridge revision that added rc.7 to the tested list (Node.js 24, macOS arm64).
- Not verified: browser-visible interaction for rc.7 beyond the automated delegation above, multi-process bridge operation against an rc.7 Host, and Host-restart durability on rc.7. Treat these as unverified until an operator run records them.

## Notes

- `host.describe.version` remains the placeholder `0.0.1` in both rc.6 and rc.7. It is never used as the compatibility gate.
- rc.6 and rc.7 both expose `agentPreset.list` and `session.selectModel`; see the multi-caller architecture and the routing design documents before building on them.
- The rc.6/rc.7 Web API has no auth token; loopback-only remains the default.
