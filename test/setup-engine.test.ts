import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { atomicInstallText, readConfigSnapshot } from "../src/setup-engine.js";

async function withTempDir(context: { after: (fn: () => unknown) => void }, prefix = "dsh-agentlink-engine-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function directoryEntries(path: string): Promise<string[]> {
  return (await readdir(path)).sort();
}

async function waitForEntry(path: string, predicate: (entry: string) => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await directoryEntries(path)).some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("timed out waiting for expected directory entry");
}

test("setup engine creates a missing config as a private regular file", async (context) => {
  const directory = await withTempDir(context);
  const configPath = join(directory, "config.toml");

  const result = await atomicInstallText({ path: configPath, content: 'model = "gpt-test"\n' });

  assert.deepEqual(result, { changed: true });
  assert.equal(await readFile(configPath, "utf8"), 'model = "gpt-test"\n');
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
});

test("setup engine preserves existing file mode and backup mode", async (context) => {
  const directory = await withTempDir(context);
  const configPath = join(directory, "config.toml");
  await writeFile(configPath, 'model = "old"\n', { mode: 0o640 });
  await chmod(configPath, 0o640);

  const result = await atomicInstallText({ path: configPath, content: 'model = "new"\n' });

  assert.equal(result.changed, true);
  assert.notEqual(result.backupPath, undefined);
  assert.equal(await readFile(result.backupPath as string, "utf8"), 'model = "old"\n');
  assert.equal((await stat(configPath)).mode & 0o777, 0o640);
  assert.equal((await stat(result.backupPath as string)).mode & 0o777, 0o640);
});

test("setup engine rejects symlinked and directory targets", async (context) => {
  const directory = await withTempDir(context);
  const targetPath = join(directory, "target.toml");
  const symlinkPath = join(directory, "symlink.toml");
  await writeFile(targetPath, 'model = "target"\n');
  await symlink(targetPath, symlinkPath);

  await assert.rejects(
    () => atomicInstallText({ path: symlinkPath, content: 'model = "new"\n' }),
    /refusing to replace symlinked config/,
  );
  await assert.rejects(
    () => atomicInstallText({ path: directory, content: 'model = "new"\n' }),
    /not a regular file/,
  );
  assert.equal(await readFile(targetPath, "utf8"), 'model = "target"\n');
});

test("setup engine no-op does not create a backup or change mtime", async (context) => {
  const directory = await withTempDir(context);
  const configPath = join(directory, "config.toml");
  await writeFile(configPath, 'model = "same"\n', { mode: 0o600 });
  const fixedTime = new Date("2026-08-16T00:00:00.000Z");
  await utimes(configPath, fixedTime, fixedTime);
  const before = await stat(configPath);
  const beforeEntries = await directoryEntries(directory);

  const result = await atomicInstallText({ path: configPath, content: 'model = "same"\n' });

  const after = await stat(configPath);
  assert.deepEqual(result, { changed: false });
  assert.deepEqual(await directoryEntries(directory), beforeEntries);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("setup engine aborts when the reviewed snapshot is stale", async (context) => {
  const directory = await withTempDir(context);
  const configPath = join(directory, "config.toml");
  await writeFile(configPath, 'model = "before"\n', { mode: 0o600 });
  const expected = await readConfigSnapshot(configPath);
  await writeFile(configPath, 'model = "after"\n', { mode: 0o600 });

  await assert.rejects(
    () => atomicInstallText({ path: configPath, content: 'model = "new"\n', expected }),
    /changed during setup/,
  );
  assert.equal(await readFile(configPath, "utf8"), 'model = "after"\n');
  assert.deepEqual(await directoryEntries(directory), ["config.toml"]);
});

test("setup engine backs up in the same directory before replacement", async (context) => {
  const directory = await withTempDir(context);
  const configPath = join(directory, "config.toml");
  await writeFile(configPath, 'model = "old"\n');

  const result = await atomicInstallText({ path: configPath, content: 'model = "new"\n', backupLabel: "codex setup" });

  assert.equal(result.changed, true);
  assert.ok(result.backupPath?.startsWith(`${configPath}.bak-codex-setup-`));
  assert.equal(dirname(result.backupPath as string), directory);
  assert.equal(await readFile(result.backupPath as string, "utf8"), 'model = "old"\n');
  assert.equal(await readFile(configPath, "utf8"), 'model = "new"\n');
});

test("setup engine handles spaces in directory and file names", async (context) => {
  const root = await withTempDir(context);
  const directory = join(root, "space dir");
  const configPath = join(directory, "config with space.toml");

  const result = await atomicInstallText({ path: configPath, content: 'model = "space"\n' });

  assert.equal(result.changed, true);
  assert.equal(await readFile(configPath, "utf8"), 'model = "space"\n');
});

test("setup engine runs post-rename text verification and cleans its temp file", async (context) => {
  const directory = await withTempDir(context);
  const configPath = join(directory, "config.toml");
  await writeFile(configPath, 'model = "old"\n');

  let observed: Error | undefined;
  try {
    await atomicInstallText({
      path: configPath,
      content: 'model = "new"\n',
      tempLabel: "verify test",
      verify: (content) => content.includes("required_block"),
    });
  } catch (error) {
    observed = error as Error;
  }

  assert.match(observed?.message ?? "", /verification failed/);
  assert.equal(await readFile(configPath, "utf8"), 'model = "new"\n');
  const entries = await directoryEntries(directory);
  const backup = entries.find((entry) => entry.startsWith("config.toml.bak-dsh-agentlink-"));
  assert.notEqual(backup, undefined);
  assert.equal(observed?.message.includes(join(directory, backup as string)), true);
  assert.equal(entries.some((entry) => entry.includes("verify-test") && entry.endsWith(".tmp")), false);
});

test("setup engine rechecks the target after temp fsync before rename", async (context) => {
  const directory = await withTempDir(context);
  const configPath = join(directory, "config.toml");
  await writeFile(configPath, 'model = "reviewed"\n', { mode: 0o600 });
  const expected = await readConfigSnapshot(configPath);
  const replacement = `${"x".repeat(32 * 1024 * 1024)}\n`;
  let keepWriting = true;
  let writes = 0;

  const writer = async (): Promise<void> => {
    while (keepWriting) {
      writes += 1;
      await writeFile(configPath, 'model = "raced"\n', { mode: 0o600 });
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const install = atomicInstallText({ path: configPath, content: replacement, expected, tempLabel: "race-test" });
  await waitForEntry(directory, (entry) => entry.includes("race-test") && entry.endsWith(".tmp"));
  const writerDone = writer();
  try {
    await assert.rejects(() => install, /changed during setup/);
  } finally {
    keepWriting = false;
    await writerDone;
  }

  assert.ok(writes > 0);
  assert.equal(await readFile(configPath, "utf8"), 'model = "raced"\n');
  const entries = await directoryEntries(directory);
  assert.notEqual(
    entries.find((entry) => entry.startsWith("config.toml.bak-dsh-agentlink-")),
    undefined,
  );
  assert.equal(entries.some((entry) => entry.includes("race-test") && entry.endsWith(".tmp")), false);
});

test("setup engine verification errors do not include config body secrets", async (context) => {
  const directory = await withTempDir(context);
  const configPath = join(directory, "config.toml");
  const secret = "super-secret-token-value";
  await writeFile(configPath, `token = "${secret}"\n`);

  await assert.rejects(
    () =>
      atomicInstallText({
        path: configPath,
        content: `token = "${secret}"\nupdated = true\n`,
        verify: () => false,
      }),
    (error) => error instanceof Error && !error.message.includes(secret),
  );
});

test("setup engine replaces verifier exceptions with a generic verification error", async (context) => {
  const directory = await withTempDir(context);
  const configPath = join(directory, "config.toml");
  const secret = "throw-secret-token-value";
  await writeFile(configPath, 'model = "old"\n');

  await assert.rejects(
    () =>
      atomicInstallText({
        path: configPath,
        content: 'model = "new"\n',
        verify: () => {
          throw new Error(`leaked ${secret}`);
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes("verification failed") &&
      !error.message.includes(secret) &&
      !("cause" in error),
  );
});

test("setup engine snapshot rejects non-file paths without following them", async (context) => {
  const directory = await withTempDir(context);
  const configPath = join(directory, "config.toml");
  await writeFile(configPath, 'model = "target"\n');
  const linkPath = join(directory, "link.toml");
  await symlink(configPath, linkPath);

  await assert.rejects(() => readConfigSnapshot(linkPath), /symlinked config/);
  assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
});
