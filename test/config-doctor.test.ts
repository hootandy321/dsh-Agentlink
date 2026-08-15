import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfig } from "../src/config.js";
import { DshTransportError } from "../src/dsh-client.js";
import { runDoctor } from "../src/doctor.js";
import { collectLockDiagnostics } from "../src/lock-doctor.js";
import { FakeDshApi } from "./support/fakes.js";

const TASK_ID = "dsh_0123456789ab";

async function makeHome() {
  return fs.mkdtemp(join(tmpdir(), "doctor-home-"));
}

function configFor(homeDir: string, hostUrl = "http://127.0.0.1:3080") {
  return loadConfig({
    DSH_BRIDGE_HOME: homeDir,
    DSH_HOST_URL: hostUrl,
    DSH_BRIDGE_TIME_ZONE: "UTC",
  });
}

const ownerFile = (token: string, pid = 4242) =>
  JSON.stringify({ pid, token, createdAt: "2024-01-01T00:00:00.000Z" });

async function writeLock(homeDir: string, relativeLockDir: string, owner?: string) {
  const lockDir = join(homeDir, relativeLockDir);
  await fs.mkdir(lockDir, { recursive: true });
  if (owner !== undefined) {
    await fs.writeFile(join(lockDir, "owner.json"), owner, { flag: "wx" });
  }
}

test("config permits loopback origins and rejects unsafe or malformed Host URLs by default", () => {
  const base = { DSH_HOME: "/tmp/dsh-test-home", DSH_BRIDGE_TIME_ZONE: "UTC" };
  assert.equal(loadConfig(base).hostUrl, "http://127.0.0.1:3080");
  assert.throws(() => loadConfig({ ...base, DSH_HOST_URL: "http://192.0.2.1:3080" }), /refusing non-loopback/);
  assert.throws(() => loadConfig({ ...base, DSH_HOST_URL: "http://127.0.0.1:3080/api" }), /origin without a path/);
  assert.throws(() => loadConfig({ ...base, DSH_HOST_URL: "http://user:pass@127.0.0.1:3080" }), /must not contain credentials/);
  assert.equal(
    loadConfig({ ...base, DSH_HOST_URL: "http://192.0.2.1:3080", DSH_ALLOW_REMOTE_HOST: "true" }).hostUrl,
    "http://192.0.2.1:3080",
  );
  assert.equal(loadConfig({ ...base, DSH_APPROVAL_TIMEOUT_MS: "250" }).approvalTimeoutMs, 250);
  assert.throws(() => loadConfig({ ...base, DSH_HOME: "" }), /must not be empty/);
});

test("doctor separates CLI and host product versions and capability-probes without writes", async () => {
  const api = new FakeDshApi();
  api.description = { version: "0.0.1", cwd: "/tmp", attachedSessions: 0, canOpenPath: true };
  const config = loadConfig({ DSH_HOME: "/tmp/dsh-test-home", DSH_BRIDGE_TIME_ZONE: "UTC" });
  const report = await runDoctor(config, api, async () => "0.1.0-rc.6");

  assert.equal(report.ok, true);
  assert.equal(report.dshCliVersion, "0.1.0-rc.6");
  assert.equal(report.hostDescribeProductVersion, "0.0.1");
  assert.equal(report.compatibility, "tested");
  assert.equal(report.capabilities.eventsMuxWebSocket, true);
  assert.equal(report.capabilities.muxResumeSince, false);
  assert.equal(api.calls.some((call) => call.method === "session.create" || call.method === "session.prompt"), false);
});

test("doctor connection failure returns a command but never starts the Host", async () => {
  const api = new FakeDshApi();
  api.hostDescribe = async () => {
    throw new DshTransportError("connection refused");
  };
  const config = loadConfig({
    DSH_HOME: "/tmp/dsh-test-home",
    DSH_HOST_URL: "http://127.0.0.1:43123",
    DSH_BRIDGE_TIME_ZONE: "UTC",
  });
  const report = await runDoctor(config, api, async () => undefined);

  assert.equal(report.ok, false);
  assert.equal(report.availability, "host_unreachable");
  assert.equal(report.startCommand, "dsh web --host 127.0.0.1 --port 43123");
  assert.equal(api.calls.some((call) => call.method === "session.create"), false);
});
test("lock diagnostics report missing paths as structural observations", async () => {
  const homeDir = await makeHome();
  try {
    const diagnostics = await collectLockDiagnostics(homeDir);
    const registry = diagnostics.locks.find((lock) => lock.kind === "registry")!;
    assert.equal(registry.presence, "missing");
    assert.equal(registry.pathType, "missing");
    assert.equal(registry.ownerPresence, "not-observed");
    assert.equal(diagnostics.ledgersPresence, "missing");
    assert.equal(diagnostics.ledgerEntriesObserved, 0);
    assert.equal(diagnostics.ledgerEntriesTruncated, false);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test("lock diagnostics never read owner.json content and JSON output never exposes its token", async () => {
  const homeDir = await makeHome();
  try {
    const token = "SECRET-owner-token-never-report";
    await writeLock(homeDir, "claims/registry.lock", ownerFile(token, 4242));
    const ownerPath = join(homeDir, "claims", "registry.lock", "owner.json");
    await fs.chmod(ownerPath, 0o000);

    const diagnostics = await collectLockDiagnostics(homeDir);
    const registry = diagnostics.locks.find((lock) => lock.kind === "registry")!;
    assert.equal(registry.presence, "present");
    assert.equal(registry.pathType, "directory");
    assert.equal(registry.ownerPresence, "present");
    assert.equal(registry.ownerType, "file");
    assert.equal(JSON.stringify(diagnostics).includes(token), false);
    assert.equal(JSON.stringify(diagnostics).includes('"pid"'), false);
    assert.equal(JSON.stringify(diagnostics).includes("createdAt"), false);
  } finally {
    await fs.chmod(join(homeDir, "claims", "registry.lock", "owner.json"), 0o600).catch(() => undefined);
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test("single-lock entry observation stops at max plus one and reports truncation", async () => {
  const homeDir = await makeHome();
  try {
    const lockDir = join(homeDir, "claims", "registry.lock");
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(join(lockDir, "owner.json"), "SECRET-not-read", { flag: "wx" });
    for (let index = 0; index < 80; index++) {
      await fs.writeFile(join(lockDir, `entry-${index.toString().padStart(3, "0")}`), "x", { flag: "wx" });
    }

    const diagnostics = await collectLockDiagnostics(homeDir);
    const registry = diagnostics.locks.find((lock) => lock.kind === "registry")!;
    assert.equal(registry.entriesObserved, registry.entryObservationLimit + 1);
    assert.equal(registry.entriesTruncated, true);
    assert.equal(registry.ownerPresence, "present");
    assert.equal(JSON.stringify(diagnostics).includes("SECRET-not-read"), false);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test("ledgers enumeration uses a max-plus-one opendir observation rather than a complete total", async () => {
  const homeDir = await makeHome();
  try {
    for (let index = 0; index < 80; index++) {
      const taskId = "dsh_" + index.toString(16).padStart(12, "0");
      await fs.mkdir(join(homeDir, "ledgers", taskId, "events.lock"), { recursive: true });
    }

    const diagnostics = await collectLockDiagnostics(homeDir);
    assert.equal(
      diagnostics.ledgerEntriesObserved,
      diagnostics.ledgerEntryObservationLimit + 1,
    );
    assert.equal(diagnostics.ledgerEntriesTruncated, true);
    assert.ok(diagnostics.eventsLocksReported <= diagnostics.ledgerEntryObservationLimit);
    assert.equal(diagnostics.eventsLocksReported, diagnostics.locks.filter((lock) => lock.kind === "events").length);
    assert.equal(
      diagnostics.locks
        .filter((lock) => lock.kind === "events")
        .every((lock) => lock.entriesObserved === 0 && lock.entriesTruncated === false),
      true,
    );
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test("lock diagnostics report symlink types without following targets", async () => {
  const homeDir = await makeHome();
  const externalDir = await fs.mkdtemp(join(tmpdir(), "doctor-symlink-ext-"));
  try {
    const target = join(externalDir, "registry.lock");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(join(target, "owner.json"), ownerFile("SECRET-external-token"), { flag: "wx" });
    await fs.mkdir(join(homeDir, "claims"), { recursive: true });
    await fs.symlink(target, join(homeDir, "claims", "registry.lock"));

    const diagnostics = await collectLockDiagnostics(homeDir);
    const registry = diagnostics.locks.find((lock) => lock.kind === "registry")!;
    assert.equal(registry.presence, "present");
    assert.equal(registry.pathType, "symbolic-link");
    assert.equal(registry.ownerPresence, "not-observed");
    assert.equal(JSON.stringify(diagnostics).includes("SECRET-external-token"), false);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(externalDir, { recursive: true, force: true });
  }
});

test("doctor includes content-free lock diagnostics on both success and Host failure", async () => {
  const homeDir = await makeHome();
  try {
    const token = "SECRET-doctor-owner-token";
    await writeLock(homeDir, "claims/registry.lock", ownerFile(token, 3333));

    const successApi = new FakeDshApi();
    successApi.description = { version: "0.0.1", cwd: "/tmp", attachedSessions: 0, canOpenPath: true };
    const success = await runDoctor(configFor(homeDir), successApi, async () => "0.1.0-rc.6");
    assert.equal(success.ok, true);
    assert.equal(success.lockDiagnostics.locks[0].ownerPresence, "present");
    assert.equal(JSON.stringify(success).includes(token), false);

    const failedApi = new FakeDshApi();
    failedApi.hostDescribe = async () => {
      throw new DshTransportError("connection refused");
    };
    const failed = await runDoctor(
      configFor(homeDir, "http://127.0.0.1:43123"),
      failedApi,
      async () => undefined,
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.availability, "host_unreachable");
    assert.equal(failed.lockDiagnostics.locks[0].ownerPresence, "present");
    assert.equal(JSON.stringify(failed).includes(token), false);
    assert.equal(failedApi.calls.some((call) => call.method === "session.create"), false);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});
