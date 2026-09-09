import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, parse } from "node:path";

export interface ConfigSnapshot {
  content: string;
  exists: boolean;
  mode: number;
}

export interface AtomicInstallTextOptions {
  path: string;
  content: string;
  expected?: ConfigSnapshot;
  backupLabel?: string;
  tempLabel?: string;
  verify?: (content: string) => boolean;
}

export interface AtomicInstallTextResult {
  changed: boolean;
  backupPath?: string;
}

function verificationError(backupPath: string | undefined): Error {
  return new Error(
    backupPath === undefined
      ? "config verification failed after replacement; inspect the target file."
      : `config verification failed after replacement; inspect the target file and backup: ${backupPath}`,
  );
}

function directorySyncError(backupPath: string | undefined): Error {
  return new Error(
    backupPath === undefined
      ? "config directory sync failed during setup; inspect the target file."
      : `config directory sync failed during setup; inspect the target file and backup: ${backupPath}`,
  );
}

function normalizeMode(mode: number): number {
  return mode & 0o777;
}

function snapshotsEqual(left: ConfigSnapshot, right: ConfigSnapshot): boolean {
  return left.exists === right.exists && left.mode === right.mode && left.content === right.content;
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80) || "setup";
}

function targetName(path: string): string {
  return parse(path).base || "config";
}

async function fsyncParentDirectory(path: string, backupPath?: string): Promise<void> {
  // Windows and some non-POSIX runtimes do not support opening/fsyncing directories.
  // In that case the file operation remains runtime-atomic, but this helper does not
  // claim power-loss durability for the containing directory entry.
  if (process.platform === "win32") return;

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dirname(path), fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    throw directorySyncError(backupPath);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readConfigSnapshot(path: string): Promise<ConfigSnapshot> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  if (noFollow !== 0) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, fsConstants.O_RDONLY | noFollow);
      const details = await handle.stat();
      if (!details.isFile()) throw new Error(`config path is not a regular file: ${path}`);
      return { content: await handle.readFile("utf8"), exists: true, mode: normalizeMode(details.mode) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { content: "", exists: false, mode: 0o600 };
      if (code === "ELOOP") throw new Error(`refusing to replace symlinked config: ${path}`);
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  const details = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (details === undefined) return { content: "", exists: false, mode: 0o600 };
  if (details.isSymbolicLink()) throw new Error(`refusing to replace symlinked config: ${path}`);
  if (!details.isFile()) throw new Error(`config path is not a regular file: ${path}`);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY);
    const opened = await handle.stat();
    if (opened.dev !== details.dev || opened.ino !== details.ino) {
      throw new Error("config changed during setup; no replacement was made. Rerun setup after reviewing it.");
    }
    return { content: await handle.readFile("utf8"), exists: true, mode: normalizeMode(opened.mode) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: "", exists: false, mode: 0o600 };
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function backupConfig(path: string, snapshot: ConfigSnapshot, label: string): Promise<string | undefined> {
  if (!snapshot.exists) return undefined;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${path}.bak-${sanitizeLabel(label)}-${timestamp}-${process.pid}-${randomUUID()}`;
  const handle = await open(backupPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, snapshot.mode);
  let closed = false;
  try {
    await handle.writeFile(snapshot.content, { encoding: "utf8" });
    await handle.chmod(snapshot.mode);
    await handle.sync();
    await handle.close();
    closed = true;
    await fsyncParentDirectory(backupPath);
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await unlink(backupPath).catch(() => undefined);
    throw error;
  }
  return backupPath;
}

async function createTemp(
  path: string,
  mode: number,
  label: string,
): Promise<{ path: string; handle: Awaited<ReturnType<typeof open>> }> {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${targetName(path)}.${sanitizeLabel(label)}-${process.pid}-${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", mode);
  return { path: temporaryPath, handle };
}

export async function atomicInstallText(options: AtomicInstallTextOptions): Promise<AtomicInstallTextResult> {
  const label = options.backupLabel ?? "dsh-agentlink";
  const tempLabel = options.tempLabel ?? label;
  const expected = options.expected ?? (await readConfigSnapshot(options.path));
  const latest = await readConfigSnapshot(options.path);
  if (!snapshotsEqual(latest, expected)) {
    throw new Error("config changed during setup; no replacement was made. Rerun setup after reviewing it.");
  }

  if (latest.exists && latest.content === options.content) return { changed: false };

  await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
  const backupPath = await backupConfig(options.path, latest, label);
  const temporary = await createTemp(options.path, latest.mode, tempLabel);
  let closed = false;
  try {
    try {
      await temporary.handle.writeFile(options.content, { encoding: "utf8" });
      await temporary.handle.chmod(latest.mode);
      await temporary.handle.sync();
    } finally {
      await temporary.handle.close();
      closed = true;
    }

    const beforeRename = await readConfigSnapshot(options.path);
    if (!snapshotsEqual(beforeRename, latest)) {
      throw new Error("config changed during setup; no replacement was made. Rerun setup after reviewing it.");
    }

    await rename(temporary.path, options.path);
    await fsyncParentDirectory(options.path, backupPath);

    const installed = await readConfigSnapshot(options.path);
    let verified = true;
    try {
      verified = options.verify?.(installed.content) ?? true;
    } catch {
      throw verificationError(backupPath);
    }
    if (!installed.exists || installed.content !== options.content || installed.mode !== latest.mode || !verified) {
      throw verificationError(backupPath);
    }
    return { changed: true, ...(backupPath === undefined ? {} : { backupPath }) };
  } finally {
    if (!closed) await temporary.handle.close().catch(() => undefined);
    await unlink(temporary.path).catch(() => undefined);
  }
}
