import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../src/config.js";
import { DshTransportError } from "../src/dsh-client.js";
import { runDoctor } from "../src/doctor.js";
import { FakeDshApi } from "./support/fakes.js";

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
