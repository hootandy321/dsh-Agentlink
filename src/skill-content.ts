export type SkillCaller = "codex" | "claude-code";

interface SkillOverlay {
  name: string;
  title: string;
  description: string;
  intro: readonly string[];
  supervisionBoundary: string;
  workspaceSupervisor: string;
}

const overlays: Record<SkillCaller, SkillOverlay> = {
  codex: {
    name: "codex-dsh",
    title: "Codex to DSH collaboration",
    description:
      "Delegate bounded work from Codex to the user's existing official DSH Web Host while preserving typed supervision, task cursors, follow-up, and safe cancellation.",
    intro: [
      "This skill operates the standalone Codex-side MCP bridge. The repository may be discovered under the broad `dsh-plugin` ecosystem topic, but it is not a DSH Cordis bundle and must not be installed with `dsh plugin --profile ... add ...`.",
      "Use the `dsh_*` MCP tools only with the user's already managed official DSH Web Host. The bridge is connect-only: never start, daemonize, stop, or reconfigure `dsh web`, and never modify DSH model settings during normal delegation.",
    ],
    supervisionBoundary: "the supervising user/Codex approval boundary",
    workspaceSupervisor: "supervising Codex",
  },
  "claude-code": {
    name: "claude-code-dsh",
    title: "Claude Code to DSH collaboration",
    description:
      "Delegate bounded work from Claude Code to the user's existing official DSH Web Host while preserving typed supervision, task cursors, follow-up, and safe cancellation.",
    intro: [
      "This skill operates the standalone MCP bridge from Claude Code to the user's official DSH Web Host. The repository may be discovered under the broad `dsh-plugin` ecosystem topic, but it is not a DSH Cordis bundle and must not be installed with `dsh plugin --profile ... add ...`.",
      "Use the `dsh_*` MCP tools only after the project MCP server has been trusted interactively with Claude Code's `/mcp` flow. The bridge is connect-only: never start, daemonize, stop, or reconfigure `dsh web`, and never modify DSH model settings during normal delegation.",
      "Headless or `dontAsk` operation cannot complete human approval safely. If Claude Code cannot show the approval prompt, reject the approval or return to the user instead of continuing.",
    ],
    supervisionBoundary: "the supervising human approval boundary",
    workspaceSupervisor: "supervising Claude Code session",
  },
};

function frontmatter(overlay: SkillOverlay): string {
  return `---\nname: ${overlay.name}\ndescription: ${overlay.description}\n---`;
}

function workflow(overlay: SkillOverlay): string {
  return `## Workflow

1. Call \`dsh_host_status\` when Host availability is unknown. If unreachable, report the doctor/start command; do not start the Host yourself.
2. Call \`dsh_delegate\` with a complete prompt and an existing absolute \`cwd\`. Omit model and normally omit \`agentPreset\`; the bridge's installation-time default owns that choice. \`agentPreset\` chooses DSH agent composition, not workspace ownership or verified sandbox policy. The shipped \`code\` preset keeps the standard capability set through DSH Code Mode and is the preferred default for implementation or multi-step tool work. Use the default \`exclusive-write\` workspace claim for edits, preferably on a dedicated git worktree; use \`read-only\` only as a bridge-local cooperative claim for tasks that should not mutate files. It does not make DSH run in a read-only filesystem sandbox. Keep the returned BridgeTask id and root session id.
3. Treat BridgeTask, root session, and turn as distinct. A completed turn can be followed by another turn in the same root session.
4. Use \`dsh_wait\` for at most 30 seconds, then \`dsh_tail\` with \`nextCursor\`. Do not poll raw per-session seq values or assume mux \`since\` resumes history.
5. Before a write, retain the latest task \`cursor\` and connection \`revision\`, then pass them as \`sinceCursor\` and \`expectedRevision\`. Inspect \`stale_view\` changes instead of blindly retrying. Use \`dsh_followup(mode="queue")\` for a later turn and \`mode="steer"\` only when guidance must enter the active turn's next step.
6. Inspect \`dsh_status.pendingInteractions\`. \`dsh_followup\` is not an answer channel.
7. Answer questions only with \`dsh_answer_question\` and the exact pending request id/typed answers. Never infer sensitive credentials, publishing, or release answers.
8. Treat every approval as sandbox escalation. Never auto-allow. Never auto-approve. Use \`dsh_resolve_approval(..., outcome="allow_once")\` only after ${overlay.supervisionBoundary}; \`reject\` is the fail-closed response.
9. Use \`dsh_cancel(scope="turn")\` to cancel only the active turn while preserving queue. Use \`scope="queue"\` only with a current queue snapshot and expect a non-atomic per-item result.
10. Independently inspect DSH-produced files and test evidence before accepting the work. When collaboration is over, call \`dsh_release_workspace\`; this does not close the DSH session.`;
}

function interpretationRules(overlay: SkillOverlay): string {
  return `## Interpretation rules

- Read availability and execution separately. \`host_unreachable\` or \`session_not_found\` must not be relabeled as task failure; retain \`lastKnownExecutionStatus\`.
- \`turn_completed\` is not task deletion. A later follow-up reuses the root session.
- Task cursors are bridge-local merge order, not DSH global causality. Delivery is at-least-once with deterministic per-session seq dedupe.
- DSH \`session.history\` is the only conversation-content source. Bridge files contain mappings, claims, cursors, lineage, watermarks, rpcIds, pending/queue state without bodies, and final-message pointers only. If the Host is unavailable, honor \`contentUnavailable\`; never infer content from local metadata.
- Stop and report \`cursor_expired\`, \`unrecoverable_gap\`, or \`terminal_missing_final\`; never silently skip or return an empty successful final answer.
- Pending questions/approvals are live Host envelopes keyed by stable rpcId and are not persisted with their text. A \`not-pending\` receipt may mean another DSH Web client won the race.
- \`dsh_cancel(scope="turn")\` does not kill DSH background jobs. Third-party tools must honor AbortSignal; use DSH job controls for background work.
- Host restarts lose process-local active/pending/queue/job state. Do not promise seamless recovery.
- A workspace claim is cooperative, persistent across turn completion, and shared only by bridge processes using the same bridge home. It does not select, enforce, or verify the DSH Host filesystem sandbox (\`workspaceClaimSemantics.controlsDshSandbox=false\` by design). While a task holds \`exclusive-write\`, the ${overlay.workspaceSupervisor} must not edit that cwd. DSH Web, a different bridge home, and ordinary shell/editor writes are outside enforcement.
- Do not change \`DSH_HOST_URL\` while reusing a bridge home. Task mappings do not persist Host affinity, so use a separate \`DSH_BRIDGE_HOME\` for another Host.

The user can inspect and interact with the same root/descendant sessions in DSH Web because all sessions are created through the configured official Host registry.`;
}

export function renderDshSkill(caller: SkillCaller): string {
  const overlay = overlays[caller];
  return `${frontmatter(overlay)}

# ${overlay.title}

${overlay.intro.join("\n\n")}

${workflow(overlay)}

${interpretationRules(overlay)}
`;
}
