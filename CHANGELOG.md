# Changelog

All notable changes to the dsh-Agentlink caller bridge are recorded here. The
caller bridge and the DSH companion use separate package versions.

## 0.2.0 — 2026-09-09

A minor-version update of the caller bridge. The companion package released
with it is `dsh-agentlink-dsh-plugin` `0.1.0`.

### Added

- Added caller attribution and task lineage. A `runId` groups multiple root
  tasks and DSH child sessions; each submission can record its caller client,
  model, service tier, and model source.
- Added the DSH companion plugin. It adds an Agentlink action to the DSH session
  header that opens a native right-sidebar tab, groups calls by caller, run, and session, and opens root and
  child sessions through the native session catalog.
- Added three cost views: the current session, all sessions in the current
  run, and the Agentlink aggregate on the current DSH Host.

### Changed

- `dsh_status` now returns a compact supervision summary by default. Callers
  can request `result`, `interactions`, `queue`, `workspace`, `sessions`,
  `connection`, `recovery`, `route`, or `cost` explicitly through `include`.
- `dsh_wait` now uses `attention` as its default wake policy. Ordinary tool
  progress and streaming chunks do not wake the caller; callers that need
  progress-level wakeups can opt into `wakeOn="activity"`.
- `dsh_tail` now provides bounded event/session reads with an independent scan
  cursor, without repeating the complete status object or normal streaming
  noise by default.
- The companion estimates API price differences by applying DSH and caller
  prices to the same observed input, cache-read, cache-write, and output token
  buckets. It does not estimate subscription billing or change the DSH model
  route.
- Unknown prices, missing usage, and uncertain request attribution remain
  unknown and are excluded from the comparable subset; they are never treated
  as zero. Manual DSH continuations remain DSH-only unless a new comparison
  submission is explicitly registered.

### Compatibility and upgrade

- Retains the existing Codex and Claude Code setup paths, interactive trust and approval boundaries, and preset launch verification from main. The new Remote adapter supports preset verification too.

- Migrated the companion from the removed `details` slot and `layout.openDetails()`
  to `sidebarRightTabs`, `sidebarRight.openTab()`, and the session-scoped
  `sidebar.right.pane.tab` slot. Closing a tab uses its own bound actions.
- The tested target is the official npm `latest` channel at DSH `0.1.5-rc.1`.
  The `next` and `alpha` channels are not targeted.
- Install the caller bridge from the repository, then install the companion
  package separately in the DSH Web profile. Rebuild and restart the DSH Host
  only after active tasks have finished, then reload the caller and DSH Web.
- The existing DSH execution model remains the source of execution behavior;
  `caller.model` is comparison metadata only.

### Verification

- The root check suite passes 172 tests, and the companion check suite passes
  30 tests. Together they cover compact response views, attention waiting,
  filtered tails, caller/run/session attribution, price calculation,
  unknown-data handling, Remote authentication, native DSH plugin loading,
  and package builds.
- The release documentation keeps the API price comparison screenshot as a
  visible README placeholder; the image is intentionally not linked until it
  is supplied.
