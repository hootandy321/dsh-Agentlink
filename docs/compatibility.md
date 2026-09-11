# Compatibility matrix

This page records which DSH versions dsh-Agentlink has actually been tested against. Version records are diagnostic evidence, not a runtime gate; the bridge gates on capability probes, not on version strings.

## Tested compatibility targets

| DSH CLI/Host version | Status | Evidence date |
|---|---|---|
| `0.1.0-rc.6` | tested | 2026-08 |
| `0.1.0-rc.7` | tested | 2026-08-19 |
| `0.1.2-rc.1` | previously tested Remote target | 2026-09-09 |
| `0.1.5-rc.1` | current target; automated adapter and companion checks | 2026-09-11 |

Any other version reports `compatible-untested` when capability probes pass, or `untested` from the long-running bridge until `DSH_HOST_VERSION` is declared with a tested value.

## 0.1.5-rc.1 evidence (2026-09-11)

- npm `latest` resolves to `0.1.5-rc.1`; `next` is `0.1.5-rc.2` and `alpha` is `0.1.5-alpha.2`. The target follows `latest`, not the numerically highest prerelease.
- The published layout package no longer provides `details` or `layout.openDetails()`. The companion now registers a native `sidebarRightTabs` page and a session-scoped `sidebar.right.pane.tab` body. Session navigation and tab-local close/guide actions are covered by tests.
- The published Gateway and Typert Registry dispatch the built companion's Remote methods in a real Cordis context. Tests cover run registration, summary, session lists, prices, invalid input, and plugin disposal.
- Remote fixtures cover launch-token/cookie authentication, control/follow streams, final messages with embedded streams, questions/approvals, and cancellation. Live assistant frames remain opt-in upstream; this bridge does not request them.
- Clean companion `npm ci`, both TypeScript builds, bridge/companion tests, and package inspection pass. Development peers are selected at rc.1 to avoid npm resolving rc.2 into the rc.1 test environment.
- Not verified on this version: a complete Web Host/browser/model run, live persistence across Host restarts, and the native spawn-to-child browser flow. Earlier live evidence below applies only to its stated version.

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

## Local upgrade diagnosis (2026-09-11)

A Host left running since September 9 continued serving the old boot manifest after its installation was updated on disk on September 11. The new browser Session Controller waited for `fileUpload`, absent from that old manifest, causing 26 dependent entries to remain pending. Restart the Host after updating its installed packages; a CLI version check alone does not identify the running Host version.

The old Host also exposed a bridge parser bug: compressed history stores N members and N - 1 successive time gaps, not N offsets. The corrected parser was verified read-only against 12 local sessions (21,521 events, including 21,185 compressed members). Regression tests cover text, reasoning and tool-call rows, cumulative time reconstruction and invalid ranges. This does not replace the outstanding full new-Host/browser/model acceptance run.
