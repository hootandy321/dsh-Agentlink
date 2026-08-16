import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import {
  CLAUDE_CODE_RESTART_HINT,
  claudeCodeIntegration,
  createClaudeCodeInstallPlan,
  defaultClaudeCodeConfigPath,
  renderClaudeCodeOperation,
  upsertClaudeCodeMcpConfig,
  verifyClaudeCodeMcpConfig,
} from "../src/claude-code-integration.js";

function firstOperation() {
  const plan = createClaudeCodeInstallPlan({
    cwd: "/tmp/project with spaces",
    nodePath: "/Applications/Node Runtime/bin/node",
    entryPath: "/tmp/dsh Agentlink/dist/mcp-server.js",
    hostUrl: "http://127.0.0.1:3080",
    dshVersion: "0.1.0-rc.7",
    preset: "code",
    replace: false,
  });
  const operation = plan.operations[0];
  assert.equal(operation?.kind, "upsert-mcp-server");
  return operation;
}

test("Claude Code integration exposes project-scoped install plan without original config secrets", () => {
  const secret = "existing-secret-value";
  const plan = createClaudeCodeInstallPlan({
    cwd: "/tmp/project",
    nodePath: "/usr/local/bin/node",
    entryPath: "/tmp/dsh-Agentlink/dist/mcp-server.js",
    hostUrl: "http://127.0.0.1:3080",
    dshVersion: "0.1.0-rc.7",
    preset: "implementation",
    replace: true,
  });
  const operation = plan.operations[0];
  const serialized = JSON.stringify(plan);

  assert.equal(plan.callerId, "claude-code");
  assert.equal(plan.callerName, "Claude Code");
  assert.deepEqual(plan.capabilities, {
    mcpStdio: true,
    configScopes: ["project"],
    instructionInstall: "manual",
    humanApprovalPrompt: "supported",
    legacyMigration: true,
    restartRequired: true,
  });
  assert.deepEqual(plan.target, {
    path: "/tmp/project/.mcp.json",
    format: "json",
    scope: "project",
  });
  assert.equal(plan.targetDescription, "Claude Code project .mcp.json file");
  assert.deepEqual(plan.verification, [{ kind: "mcp-server-block-matches", serverName: "dsh_agentlink" }]);
  assert.equal(plan.restartHint, CLAUDE_CODE_RESTART_HINT);
  assert.match(plan.restartHint, /\/mcp/);
  assert.match(plan.restartHint, /DSH Web Host/);
  assert.equal(operation?.serverName, "dsh_agentlink");
  assert.deepEqual(operation?.legacyServerNames, ["dsh_collab"]);
  assert.equal(operation?.command, "/usr/local/bin/node");
  assert.deepEqual(operation?.args, ["/tmp/dsh-Agentlink/dist/mcp-server.js"]);
  assert.deepEqual(operation?.env, {
    DSH_HOST_URL: "http://127.0.0.1:3080",
    DSH_HOST_VERSION: "0.1.0-rc.7",
    DSH_BRIDGE_AGENT_PRESET: "implementation",
  });
  assert.deepEqual(operation?.humanApproval, { toolName: "dsh_resolve_approval", mode: "human-prompt" });
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("existingConfig"), false);
  assert.equal(serialized.includes("renderedBlock"), false);
  assert.equal(serialized.includes("content"), false);
});

test("Claude Code render produces stdio JSON shape and handles paths with spaces", () => {
  assert.deepEqual(renderClaudeCodeOperation(firstOperation()), {
    type: "stdio",
    command: "/Applications/Node Runtime/bin/node",
    args: ["/tmp/dsh Agentlink/dist/mcp-server.js"],
    env: {
      DSH_HOST_URL: "http://127.0.0.1:3080",
      DSH_HOST_VERSION: "0.1.0-rc.7",
      DSH_BRIDGE_AGENT_PRESET: "code",
    },
  });
});

test("Claude Code setup path is project local", () => {
  assert.equal(defaultClaudeCodeConfigPath("/tmp/project"), join("/tmp/project", ".mcp.json"));
  assert.equal(claudeCodeIntegration.defaultConfigPath({ cwd: "/tmp/project", env: {} }), "/tmp/project/.mcp.json");

  const plan = createClaudeCodeInstallPlan({
    cwd: "/tmp/project",
    nodePath: "/usr/local/bin/node",
    entryPath: "/tmp/dsh-Agentlink/dist/mcp-server.js",
    hostUrl: "http://127.0.0.1:3080",
    replace: false,
  });
  assert.deepEqual(plan.target, {
    path: "/tmp/project/.mcp.json",
    format: "json",
    scope: "project",
  });
});

test("Claude Code upsert preserves unrelated top-level fields and servers", () => {
  const original = JSON.stringify(
    {
      note: "keep",
      privateToken: "existing-secret-value",
      mcpServers: {
        other: {
          type: "stdio",
          command: "/bin/echo",
          args: ["ok"],
          env: { KEEP: "yes" },
        },
      },
    },
    null,
    2,
  );

  const updated = upsertClaudeCodeMcpConfig(original, firstOperation());
  const parsed = JSON.parse(updated) as {
    note: string;
    privateToken: string;
    mcpServers: Record<string, unknown>;
  };

  assert.equal(updated.endsWith("\n"), true);
  assert.equal(parsed.note, "keep");
  assert.equal(parsed.privateToken, "existing-secret-value");
  assert.deepEqual(parsed.mcpServers.other, {
    type: "stdio",
    command: "/bin/echo",
    args: ["ok"],
    env: { KEEP: "yes" },
  });
  assert.deepEqual(parsed.mcpServers.dsh_agentlink, renderClaudeCodeOperation(firstOperation()));
  assert.equal(verifyClaudeCodeMcpConfig(updated, firstOperation()), true);
});

test("Claude Code upsert creates deterministic pretty JSON from an empty file", () => {
  const updated = upsertClaudeCodeMcpConfig("", firstOperation());

  assert.equal(
    updated,
    `${JSON.stringify(
      {
        mcpServers: {
          dsh_agentlink: renderClaudeCodeOperation(firstOperation()),
        },
      },
      null,
      2,
    )}\n`,
  );
});

test("Claude Code setup requires replacement for conflicting canonical or legacy entries", () => {
  const canonicalConflict = JSON.stringify({
    mcpServers: {
      dsh_agentlink: { type: "stdio", command: "/old/node", args: ["/old/server.js"], env: {} },
      other: { type: "stdio", command: "/bin/echo", args: ["ok"], env: {} },
    },
  });
  const legacyConflict = JSON.stringify({
    mcpServers: {
      dsh_collab: { type: "stdio", command: "/old/node", args: ["/old/server.js"], env: {} },
      other: { type: "stdio", command: "/bin/echo", args: ["ok"], env: {} },
    },
  });

  assert.throws(() => upsertClaudeCodeMcpConfig(canonicalConflict, firstOperation()), /already exists/);
  assert.throws(() => upsertClaudeCodeMcpConfig(legacyConflict, firstOperation()), /legacy dsh_collab already exists/);
});

test("Claude Code replacement removes legacy and canonical entries and writes only canonical", () => {
  const replacePlan = createClaudeCodeInstallPlan({
    cwd: "/tmp/project",
    nodePath: "/usr/local/bin/node",
    entryPath: "/tmp/dsh-Agentlink/dist/mcp-server.js",
    hostUrl: "http://127.0.0.1:3080",
    replace: true,
  });
  const operation = replacePlan.operations[0];
  assert.equal(operation?.kind, "upsert-mcp-server");
  const original = JSON.stringify({
    mcpServers: {
      dsh_collab: { type: "stdio", command: "/old/node", args: ["/old/server.js"], env: { OLD: "yes" } },
      dsh_agentlink: { type: "stdio", command: "/duplicate/node", args: ["/duplicate/server.js"], env: {} },
      other: { type: "stdio", command: "/bin/echo", args: ["ok"], env: {} },
    },
  });

  const updated = upsertClaudeCodeMcpConfig(original, operation);
  const parsed = JSON.parse(updated) as { mcpServers: Record<string, unknown> };

  assert.equal(Object.hasOwn(parsed.mcpServers, "dsh_collab"), false);
  assert.deepEqual(parsed.mcpServers.dsh_agentlink, renderClaudeCodeOperation(operation));
  assert.deepEqual(parsed.mcpServers.other, { type: "stdio", command: "/bin/echo", args: ["ok"], env: {} });
});

test("Claude Code equivalent canonical config verifies and upsert is a no-op", () => {
  const operation = firstOperation();
  const existing = `${JSON.stringify(
    {
      mcpServers: {
        dsh_agentlink: renderClaudeCodeOperation(operation),
      },
    },
    null,
    2,
  )}\n`;

  assert.equal(verifyClaudeCodeMcpConfig(existing, operation), true);
  assert.equal(upsertClaudeCodeMcpConfig(existing, operation), existing);
  assert.equal(claudeCodeIntegration.verifyInstalled(existing, operation), true);
});

test("Claude Code verification fails when legacy duplicate remains", () => {
  const operation = firstOperation();
  const existing = JSON.stringify({
    mcpServers: {
      dsh_agentlink: renderClaudeCodeOperation(operation),
      dsh_collab: renderClaudeCodeOperation(operation),
    },
  });

  assert.equal(verifyClaudeCodeMcpConfig(existing, operation), false);
  assert.throws(() => upsertClaudeCodeMcpConfig(existing, operation), /already exists/);
});

test("Claude Code verification rejects canonical server extra fields", () => {
  const operation = firstOperation();
  const canonical = renderClaudeCodeOperation(operation);
  const existing = JSON.stringify({
    mcpServers: {
      dsh_agentlink: {
        ...canonical,
        disabled: false,
      },
    },
  });

  assert.equal(verifyClaudeCodeMcpConfig(existing, operation), false);
  assert.throws(() => upsertClaudeCodeMcpConfig(existing, operation), /already exists/);
});

test("Claude Code equivalent verification ignores JSON object key order", () => {
  const operation = firstOperation();
  const existing = JSON.stringify({
    mcpServers: {
      dsh_agentlink: {
        env: {
          DSH_BRIDGE_AGENT_PRESET: "code",
          DSH_HOST_VERSION: "0.1.0-rc.7",
          DSH_HOST_URL: "http://127.0.0.1:3080",
        },
        args: ["/tmp/dsh Agentlink/dist/mcp-server.js"],
        command: "/Applications/Node Runtime/bin/node",
        type: "stdio",
      },
    },
  });

  assert.equal(verifyClaudeCodeMcpConfig(existing, operation), true);
  assert.equal(upsertClaudeCodeMcpConfig(existing, operation), existing);
});

test("Claude Code setup rejects invalid JSON shapes fail closed", () => {
  const operation = firstOperation();

  assert.throws(() => upsertClaudeCodeMcpConfig("{", operation), /strict JSON/);
  assert.throws(() => upsertClaudeCodeMcpConfig("[]", operation), /root must be a JSON object/);
  assert.throws(() => upsertClaudeCodeMcpConfig("null", operation), /root must be a JSON object/);
  assert.throws(() => upsertClaudeCodeMcpConfig('{"mcpServers":[]}', operation), /mcpServers must be a JSON object/);
  assert.throws(() => upsertClaudeCodeMcpConfig('{"mcpServers":null}', operation), /mcpServers must be a JSON object/);
  assert.equal(verifyClaudeCodeMcpConfig("{", operation), false);
});

test("Claude Code setup refuses to rewrite unrelated integers that cannot be preserved exactly", () => {
  const operation = firstOperation();
  const config = '{"revision":9007199254740993,"mcpServers":{"other":{"command":"other"}}}';

  assert.throws(() => upsertClaudeCodeMcpConfig(config, operation), /cannot preserve exactly/);
  assert.equal(verifyClaudeCodeMcpConfig(config, operation), false);
});

test("Claude Code integration rejects non-absolute command and entry paths", () => {
  assert.throws(
    () =>
      createClaudeCodeInstallPlan({
        cwd: "/tmp/project",
        nodePath: "node",
        entryPath: "/tmp/dsh-Agentlink/dist/mcp-server.js",
        hostUrl: "http://127.0.0.1:3080",
        replace: false,
      }),
    /command must be an absolute path/,
  );
  assert.throws(
    () =>
      createClaudeCodeInstallPlan({
        cwd: "/tmp/project",
        nodePath: "/usr/local/bin/node",
        entryPath: "dist/mcp-server.js",
        hostUrl: "http://127.0.0.1:3080",
        replace: false,
      }),
    /entry path must be an absolute path/,
  );
  assert.throws(
    () =>
      createClaudeCodeInstallPlan({
        cwd: "relative-project",
        nodePath: "/usr/local/bin/node",
        entryPath: "/tmp/dsh-Agentlink/dist/mcp-server.js",
        hostUrl: "http://127.0.0.1:3080",
        replace: false,
      }),
    /project directory must be an absolute path/,
  );
});
