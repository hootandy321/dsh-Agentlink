#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import type { BridgeConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { DshClient } from "./dsh-client.js";
import type { DshApi } from "./dsh-types.js";
import { collectLockDiagnostics } from "./lock-doctor.js";

const execFileAsync = promisify(execFile);
const TESTED_CLI_VERSION = "0.1.0-rc.6";

export type CliVersionProbe = () => Promise<string | undefined>;

export async function probeDshCliVersion(): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync("dsh", ["--version"], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    const value = `${stdout}${stderr}`.trim().split(/\s+/).at(-1);
    return value === undefined || value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

function startCommand(hostUrl: string): string {
  const url = new URL(hostUrl);
  const host = url.hostname === "[::1]" ? "::1" : url.hostname;
  const port = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
  return `dsh web --host ${host} --port ${port}`;
}

async function probeMux(api: DshApi): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  let opened = false;
  const consume = (async () => {
    try {
      for await (const _frame of api.openMux(controller.signal, () => {
        opened = true;
        controller.abort();
      })) {
        break;
      }
    } catch (error) {
      if (!opened) throw error;
    }
  })();
  try {
    await Promise.race([
      consume,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("events.mux open timed out")), 5_000);
        timer.unref?.();
      }),
    ]);
    return opened ? { ok: true } : { ok: false, error: "events.mux closed before opening" };
  } catch (error) {
    controller.abort();
    await consume.catch(() => undefined);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runDoctor(
  config: BridgeConfig,
  api: DshApi,
  cliVersionProbe: CliVersionProbe = probeDshCliVersion,
) {
  const cliVersion = await cliVersionProbe();
  const lockDiagnostics = await collectLockDiagnostics(config.homeDir);
  try {
    const description = await api.hostDescribe();
    const sessions = await api.sessionList();
    const mux = await probeMux(api);
    const coreCapabilities = {
      hostDescribe: true,
      sessionList: true,
      eventsMuxWebSocket: mux.ok,
      history: sessions.items.length === 0 ? "not-probed-no-session" : "not-yet-probed",
      respond: "contract-only-not-mutated",
      queueMutation: "contract-only-not-mutated",
      muxResumeSince: false,
    } as const;
    let history: boolean | "not-probed-no-session" = "not-probed-no-session";
    if (sessions.items[0] !== undefined) {
      try {
        await api.sessionHistory(sessions.items[0].sessionId, { maxMessages: 1 });
        history = true;
      } catch {
        history = false;
      }
    }
    const coreCompatible = mux.ok && history !== false;
    const testedBuild = cliVersion === TESTED_CLI_VERSION;
    return {
      ok: coreCompatible,
      connectOnly: true,
      baseUrl: config.hostUrl,
      checkedAt: new Date().toISOString(),
      dshCliVersion: cliVersion ?? null,
      testedCliVersion: TESTED_CLI_VERSION,
      hostDescribeProductVersion: description.version,
      hostVersionWarning:
        description.version === "0.0.1"
          ? "rc.6 host.describe.version is a known placeholder and is not the DSH CLI/package version"
          : "host.describe.version is reported separately and is not used as the CLI compatibility gate",
      compatibility: testedBuild && coreCompatible ? "tested" : coreCompatible ? "compatible-untested" : "incompatible",
      warning: testedBuild
        ? undefined
        : `Only DSH CLI ${TESTED_CLI_VERSION} has been locally verified; detected ${cliVersion ?? "unknown"}`,
      capabilities: { ...coreCapabilities, history },
      muxError: mux.error,
      sessionCount: sessions.items.length,
      description,
      lockDiagnostics,
    };
  } catch (error) {
    return {
      ok: false,
      connectOnly: true,
      baseUrl: config.hostUrl,
      checkedAt: new Date().toISOString(),
      dshCliVersion: cliVersion ?? null,
      testedCliVersion: TESTED_CLI_VERSION,
      availability: "host_unreachable",
      error: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
      startCommand: startCommand(config.hostUrl),
      note: "The bridge never starts, daemonizes, or stops dsh web; run this command yourself or manage it with the OS.",
      lockDiagnostics,
    };
  }
}

async function main() {
  const config = loadConfig();
  const report = await runDoctor(config, new DshClient(config.hostUrl, config.requestTimeoutMs));
  const output = JSON.stringify(report, null, 2);
  if (report.ok) console.log(output);
  else {
    console.error(output);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error) => {
    console.error(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  });
}
