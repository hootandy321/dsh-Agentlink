import test from "node:test";
import assert from "node:assert/strict";
import { enrichSessionListWithSubagentCatalog } from "../src/index.js";
import type { SessionListRecord } from "../src/types.js";

const rows: SessionListRecord[] = [
  { sessionId: "parent", runId: "run-1", taskId: "task-1", rootSessionId: "parent", origin: "delegated", createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z" },
  { sessionId: "child", runId: "run-1", taskId: "task-1", rootSessionId: "parent", parentSessionId: "parent", origin: "dsh-internal", createdAt: "2026-09-09T00:00:01.000Z", updatedAt: "2026-09-09T00:00:01.000Z" }
];

test("subagent navigation enrichment uses Host listChildren catalog entries", async () => {
  const parents: string[] = [];
  const enriched = await enrichSessionListWithSubagentCatalog({
    subagents: {
      async listChildren(parentSessionId: string) {
        parents.push(parentSessionId);
        return [
          { kind: "diagnostic", id: "bad", reason: "unavailable" },
          { kind: "child", id: "child", mode: "continuable", activity: "inactive", hasChildren: false, label: "child" }
        ];
      }
    }
  } as never, rows);

  assert.deepEqual(parents, ["parent"]);
  assert.deepEqual(enriched.find((row) => row.sessionId === "child")?.subagentAddress, {
    parentSessionId: "parent",
    childSessionId: "child",
    mode: "continuable"
  });
  assert.equal(enriched.find((row) => row.sessionId === "parent")?.subagentAddress, undefined);
});

test("subagent navigation enrichment does not fabricate missing modes", async () => {
  const enriched = await enrichSessionListWithSubagentCatalog({
    subagents: {
      async listChildren() {
        return [{ kind: "child", id: "child", activity: "running", hasChildren: false }];
      }
    }
  } as never, rows);

  assert.equal(enriched.find((row) => row.sessionId === "child")?.subagentAddress, undefined);
});
