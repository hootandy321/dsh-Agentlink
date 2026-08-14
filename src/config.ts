import { homedir } from "node:os";
import { resolve } from "node:path";

export interface BridgeConfig {
  hostUrl: string;
  homeDir: string;
  requestTimeoutMs: number;
  allowRemoteHost: boolean;
  defaultAgentPreset?: string;
  clientTimeZone?: string;
  declaredDshVersion?: string;
  approvalTimeoutMs?: number;
}

const DEFAULT_HOST_URL = "http://127.0.0.1:3080";
const DEFAULT_TIMEOUT_MS = 30_000;

function booleanEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function optionalPositiveIntegerEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return positiveIntegerEnv(value, 1);
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function normalizeHostUrl(raw: string, allowRemoteHost: boolean): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`DSH host URL must use http or https, received ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("DSH host URL must not contain credentials");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("DSH host URL must be an origin without a path, query, or fragment");
  }
  if (!allowRemoteHost && !isLoopback(url.hostname)) {
    throw new Error(
      `refusing non-loopback DSH host ${url.hostname}; set DSH_ALLOW_REMOTE_HOST=true only for a trusted deployment`,
    );
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function detectTimeZone(): string | undefined {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timeZone === "" ? undefined : timeZone;
  } catch {
    return undefined;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const allowRemoteHost = booleanEnv(env.DSH_ALLOW_REMOTE_HOST);
  if (env.DSH_HOME !== undefined && env.DSH_HOME.trim() === "") throw new Error("DSH_HOME must not be empty");
  if (env.DSH_BRIDGE_HOME !== undefined && env.DSH_BRIDGE_HOME.trim() === "") {
    throw new Error("DSH_BRIDGE_HOME must not be empty");
  }
  const dshHome = env.DSH_HOME === undefined ? resolve(homedir(), ".dsh") : resolve(env.DSH_HOME);
  const defaultAgentPreset = env.DSH_BRIDGE_AGENT_PRESET?.trim();
  const clientTimeZone = env.DSH_BRIDGE_TIME_ZONE?.trim() || detectTimeZone();
  const declaredDshVersion = env.DSH_HOST_VERSION?.trim();
  const approvalTimeoutMs = optionalPositiveIntegerEnv(env.DSH_APPROVAL_TIMEOUT_MS);

  return {
    hostUrl: normalizeHostUrl(env.DSH_HOST_URL ?? DEFAULT_HOST_URL, allowRemoteHost),
    homeDir: resolve(env.DSH_BRIDGE_HOME ?? resolve(dshHome, "codex-bridge")),
    requestTimeoutMs: positiveIntegerEnv(env.DSH_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    allowRemoteHost,
    ...(defaultAgentPreset === undefined || defaultAgentPreset === "" ? {} : { defaultAgentPreset }),
    ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    ...(declaredDshVersion === undefined || declaredDshVersion === "" ? {} : { declaredDshVersion }),
    ...(approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs }),
  };
}
