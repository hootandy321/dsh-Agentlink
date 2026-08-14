#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BridgeService } from "./bridge-service.js";
import { loadConfig } from "./config.js";
import { DshConnectionManager } from "./connection-manager.js";
import { DshClient } from "./dsh-client.js";
import { EventLedger } from "./event-ledger.js";
import { createMcpServer } from "./mcp-server.js";
import { TaskStore } from "./task-store.js";

async function main() {
  const config = loadConfig();
  const api = new DshClient(config.hostUrl, config.requestTimeoutMs);
  const tasks = new TaskStore(config.homeDir);
  const ledger = new EventLedger(config.homeDir);
  const connection = new DshConnectionManager(config, api, tasks, ledger);
  const service = new BridgeService(config, api, tasks, connection, ledger);
  const server = createMcpServer(service);
  const transport = new StdioServerTransport();
  let closing = false;

  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await connection.stop().catch(() => undefined);
    await server.close().catch(() => undefined);
  };

  transport.onclose = () => {
    void shutdown();
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  connection.start();
  await server.connect(transport);
  console.error(`[dsh-orchestrator] connect-only MCP ready; configured DSH Host ${config.hostUrl}`);
}

void main().catch((error) => {
  console.error(`[dsh-orchestrator] fatal: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  process.exitCode = 1;
});
