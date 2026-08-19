# Security policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting when it is enabled for the repository. If it is unavailable, open a minimal public issue asking for a private contact channel without including exploit details, credentials, private paths, or session content.

Do not report secrets by pasting them into an issue, discussion, test fixture, or log attachment.

## Security model

The bridge is a local supervisor, not an authentication boundary.

- It connects to a user-managed DSH Web Host and does not own the Host process lifecycle.
- Loopback is the default. A non-loopback Host requires the explicit `DSH_ALLOW_REMOTE_HOST=true` opt-in.
- The currently targeted DSH Web API has no authentication token. Host/Origin checks do not replace authentication.
- Conversation content remains in DSH session history. Bridge persistence contains coordination metadata and content pointers only.
- DSH approval requests are sandbox escalations. The bridge never auto-allows them, and `allow_once` must remain human-gated.
- Workspace claims coordinate cooperating bridge processes; they do not select, enforce, or verify the DSH Host filesystem sandbox, and they do not prevent writes from DSH Web, editors, shells, another bridge home, or other software.
- Cancellation is best effort. Background jobs and third-party tools may outlive a canceled turn unless DSH or the tool explicitly terminates them.

## Supported versions

The README names the exact DSH compatibility target. Other DSH versions are untested until capability probes and the live acceptance procedure pass. Because DSH is in developer preview, compatibility-breaking changes should be expected.
