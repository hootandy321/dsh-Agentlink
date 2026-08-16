# dsh-Agentlink

![dsh-Agentlink cover](assets/dsh-agentlink-cover.webp)

[![CI](https://github.com/hootandy321/dsh-Agentlink/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hootandy321/dsh-Agentlink/actions/workflows/ci.yml) [![GitHub Stars](https://img.shields.io/github/stars/hootandy321/dsh-Agentlink?style=flat-square&logo=github)](https://github.com/hootandy321/dsh-Agentlink/stargazers) [![License: MIT](https://img.shields.io/github/license/hootandy321/dsh-Agentlink?style=flat-square)](LICENSE) [![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![DSH plugin](https://img.shields.io/badge/DSH-plugin-4B6BFB?style=flat-square)](https://www.deepseek.com/harness/en/)

**English** | [简体中文](README.zh-CN.md)

dsh-Agentlink is a plugin that lets you use DeepSeek Harness (DSH) from the AI work tool you already use. Your primary agent can delegate implementation, research, debugging, and long-log work to DSH, then observe, continue, or cancel those sessions without leaving its normal workflow. Codex and Claude Code are supported; Workbuddy and other popular AI coding and agent tools are planned.

## Installation

Prepare the environment first: you need **Node.js 22+**, a supported caller (**Codex or Claude Code**), and a working **DSH CLI**. Configure your preferred model in DSH once; dsh-Agentlink uses that live route automatically.

### Install with your AI agent

Send the following repository URL and prompt to Codex or another coding agent:

```text
Install dsh-Agentlink from https://github.com/hootandy321/dsh-Agentlink.
Check Node.js 22+, the DSH CLI, and my DSH Web Host first. Clone it into a location I approve,
run npm install and npm test. For Codex, run npm run setup -- --yes. For Claude Code, run
npm run setup:claude -- --yes --project /absolute/path/to/my/project.
For Claude Code, review the shipped skill before installing it; never overwrite an existing project skill silently.
If dsh_agentlink or the legacy dsh_collab entry already exists, show me the conflict before using --replace.
Do not start or stop dsh web for me. Tell me when I need to reload the selected caller and approve project MCP trust.
```

### Manual installation

1. Check the environment. DSH CLI `0.1.0-rc.6` is the current tested target.

   ```bash
   node --version
   dsh --version
   ```

2. Start the official DSH Web Host in its own terminal.

   ```bash
   dsh web
   ```

3. Clone the repository and install its dependencies.

   ```bash
   git clone https://github.com/hootandy321/dsh-Agentlink.git
   cd dsh-Agentlink
   npm install
   ```

4. Configure your caller.

   For Codex:

   ```bash
   npm run setup
   npm run doctor
   ```

   The Codex wizard backs up the Codex TOML configuration and installs the MCP entry with `approval_mode = "prompt"`. Restart Codex, then use `/mcp` or Codex Settings to confirm that `dsh_agentlink` is connected. For fully manual TOML setup, see [Manual Codex MCP configuration](docs/manual-configuration.md).

   For Claude Code 2.1.199 or newer, point the setup command at the project that should share `.mcp.json`:

   ```bash
   npm run setup:claude -- --project /absolute/path/to/your/project
   cd /absolute/path/to/your/project
   claude mcp get dsh_agentlink
   ```

   The Claude setup only edits that project's `.mcp.json`, preserves unrelated servers, and reports MCP registration, project trust, Claude approval support, and DSH Host reachability separately. Open Claude Code in the project and approve the pending server through `/mcp`; the bridge marks `dsh_resolve_approval` as requiring human interaction. The setup does not overwrite Claude skills: review the shipped `skill/claude-code-dsh/SKILL.md` before manually installing it as `.claude/skills/claude-code-dsh/SKILL.md` in the target project.

   Add `--yes` for unattended defaults. To update an existing entry, review it first and then add `--replace`. Both installers recognize the legacy `dsh_collab` entry and migrate it to `dsh_agentlink` only after explicit replacement approval. Neither installer starts DSH or restarts the caller.

The doctor reports the bridge's fail-closed lock locations under `DSH_BRIDGE_HOME` read-only and never cleans them, so it is safe to run even when a lock is present.

This source patch stops new projection/chunk floods from expanding the coordination ledger, but it does not compact an existing 5 MB+ ledger. Preserve the old bridge home for inspection; new delegations can use a separate `DSH_BRIDGE_HOME`. DSH `session.history`, not the bridge ledger, remains the conversation source of truth. See [Known issues](KNOWN_ISSUES.md) for the conservative recovery boundary.

dsh-Agentlink is a caller-side plugin, not a DSH Cordis bundle. Do not install it with `dsh plugin --profile ... add ...`.

## Why dsh-Agentlink?

### Use DSH's Harness capabilities

DSH combines persistent sessions, tool execution, subagents, and human supervision for complex work. dsh-Agentlink lets Codex discuss and coordinate with that second harness while you stay in the same workflow.

![Codex coordinating work with DeepSeek Harness](assets/codex-dsh-collaboration.webp)

*Codex keeps planning and supervision; DSH provides the execution harness, sessions, and workers.*

### More than another native subagent

A native subagent remains inside the caller's own agent tree. dsh-Agentlink adds a separate, user-configured harness: its sessions stay visible in DSH Web, can use DSH's own workers and model route, and can be observed, continued, or canceled by Codex.

![dsh-Agentlink compared with native subagents](assets/dsh-vs-native-subagents.webp)

*Use the primary agent for judgment and validation, while DSH handles larger execution workloads through the model you configured there.*

### Save time and cost

- **Save time.** Route implementation, research, extraction, and long-log work to a fast model configured in DSH, such as a DeepSeek V4 route, while your primary agent keeps planning and validating.
- **Save money.** Moving execution-heavy workloads to a lower-cost DeepSeek route can reduce consumption on more expensive primary models.

Actual speed and cost depend on the selected model, provider, deployment, network, and task. Once installed, you can keep working in Codex or Claude Code as usual and simply ask it to delegate when DSH is the better execution path.

## Use it

Once `dsh web` is running and your caller has loaded and trusted the MCP configuration, ask Codex or Claude Code in normal language, for example:

> Use dsh-Agentlink to delegate this implementation to DSH in the current repository. Keep it visible in DSH Web, report progress, and ask me before any approval.

The caller can then delegate the task, observe its event stream, continue the same session, answer questions with you, or cancel work. Open `http://127.0.0.1:3080` to inspect and interact with the same session in DSH Web.

## MCP tools

- `dsh_host_status` — connect-only Host state and capabilities
- `dsh_delegate` — create a root session and queue the initial prompt; detached by default (`waitSeconds=0`)
- `dsh_followup` — continue the same root session with explicit `mode="queue"|"steer"` (default `queue`)
- `dsh_continue` — compatibility alias for `dsh_followup`
- `dsh_status` — availability, execution, lineage, queue, pending interactions, final message, and cursors
- `dsh_tail` — bounded event digests using a bridge task cursor
- `dsh_wait` — wait up to 30 seconds for a durable event, state change, pending interaction, or terminal status
- `dsh_observe` — compatibility alias around `dsh_wait`; bridge cursors replace raw session seq cursors
- `dsh_cancel` — `scope="turn"|"queue"`
- `dsh_list` — task mappings enriched with current derived status
- `dsh_answer_question` — typed answer for a pending question rpcId
- `dsh_resolve_approval` — typed `allow_once|reject` response for a pending approval rpcId
- `dsh_release_workspace` — explicitly release a persistent bridge workspace claim without closing the DSH session

Normal delegation has no model argument. Configure the desired model only when installing or adjusting DSH. Each delegate reads `session.models.current` and trusts the Host's `routable` boolean; it neither changes the model nor derives routability from catalog groups.

`dsh_wait` observes durable bridge state. Assistant delta/chunk frames and top-level `session/projection` snapshots are skipped, so they do not bump the task revision or wake waiters; complete final messages remain observable through status/tail after the turn ends.

## Roadmap

These are planned directions, not implemented capabilities or release commitments.

1. **More caller entrypoints** — add ZCode, Workbuddy, Claude Desktop MCP, and other callers through the shared Integration Pack architecture.
2. **Agent invocation and information transport** — improve prompt organization, context packaging, output digests, and compression while keeping questions, approvals, errors, and final answers reliable.
3. **More integrations** — expand after the Codex bridge and its compatibility contract stabilize.

## More documentation

- [Architecture and safety model](docs/architecture.md) — identity, state, recovery, approvals, cancellation, and workspace coordination
- [Multi-caller extension architecture](docs/caller-integration-architecture.md) — shared Runtime and Integration Pack boundaries for Codex, Claude Code, and future callers
- [Validation guide](docs/validation.md) — compatibility and operator acceptance checks
- [Known issues](KNOWN_ISSUES.md) — current upgrade and concurrency caveats
- [Contributing](CONTRIBUTING.md) and [security](SECURITY.md)

## License

[MIT](LICENSE)

Alpha note: DSH is still in developer preview and this community project is independent of DeepSeek and OpenAI. `0.1.0-alpha.1` contains a shared-ledger concurrency bug; the fix is in source and pending release. Read [Known issues](KNOWN_ISSUES.md) before upgrading or running concurrent bridge processes.
