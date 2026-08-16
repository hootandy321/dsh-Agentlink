# Reviewing pull requests

This repository uses two complementary review layers. GitHub Actions runs deterministic checks on every pull request, including pull requests from forks. Codex supplies a semantic review of review-ready pull requests when automatic Code Review is enabled for the repository. A maintainer remains responsible for the merge decision; automation never approves DSH sandbox escalations or merges a pull request.

The English document is authoritative; the Chinese version should remain semantically aligned with it.

## Repository setup

1. Connect the repository to Codex cloud.
2. Open Codex settings, enable **Code review** for `hootandy321/dsh-Agentlink`, and turn on **Automatic reviews**.
3. Keep the branch-protection check named `check` required and up to date with `main`.
4. After changing the rules in [`AGENTS.md`](../AGENTS.md), open a representative pull request and use `@codex review` to verify that the rules produce useful, low-noise findings.

Automatic review is an account/repository setting rather than a workflow secret. Do not add an API key or a privileged `pull_request_target` workflow merely to duplicate it.

## What runs for each pull request

The `CI` workflow is triggered when a pull request is opened, reopened, updated, or marked ready for review. It receives a read-only GitHub token and no repository secrets for fork pull requests, then runs:

```bash
npm ci
npm run check
npm pack --dry-run --ignore-scripts
```

GitHub currently requires a maintainer to approve the first Actions run from a first-time external contributor. The workflow is still created for that PR, but deterministic checks wait for this repository-level abuse-prevention approval; this safeguard should not be weakened merely to remove the click.

Codex reviews the pull request diff and follows the repository-specific `## Code Review Rules` in `AGENTS.md`. Automatic reviews cover newly review-ready pull requests and intentionally focus GitHub comments on serious P0/P1 findings. Add `@codex review` in a pull request comment to request another pass after changing the implementation or the review guidance.

## Human review procedure

1. **Confirm intent and scope.** Read the issue, pull request body, changed-file list, and dependency/lockfile changes. Reject unrelated refactors or hidden generated artifacts.
2. **Trace consequential behavior.** Follow the changed path through the MCP frontend, shared service, DSH backend, persistence, and setup boundary as applicable. Check failure, reconnect, cancellation, and concurrent-process behavior, not only the happy path.
3. **Apply the repository invariants.** Pay particular attention to connect-only Host ownership, conversation-content exclusion, human-gated approvals, live Host reads, cursor durability, and one shared Runtime for every caller.
4. **Validate evidence.** Require a focused regression test for externally visible behavior. Use mock-host tests for deterministic protocol behavior and the validation guide for claims that depend on a live DSH version.
5. **Classify findings.** Block on exploitable security problems, data leakage, state corruption, lost approvals/questions, incorrect cancellation, broken recovery, or a documented compatibility regression. Keep style preferences and speculative redesigns non-blocking.
6. **Resolve and re-run.** Update the branch, wait for the required `check`, re-request Codex review when useful, and resolve review threads only after the code or explanation addresses the finding.

## Security boundary for external pull requests

The CI workflow intentionally uses `pull_request` with `contents: read`. It may execute contributor-controlled package scripts and tests, but it has no repository secrets or write token on fork pull requests. Do not change it to execute pull request code under `pull_request_target`, `workflow_run`, a secret-bearing job, or a machine that exposes a maintainer's local DSH credentials.

If a separate review bot is introduced later, it must be advisory, use least privilege, treat titles, bodies, filenames, and patches as untrusted input, and never automatically approve or merge.

## Manual commands

```bash
npm ci
npm run check
npm pack --dry-run --ignore-scripts
```

For DSH compatibility changes, also follow [`docs/validation.md`](validation.md) and record the exact DSH version and live evidence.
