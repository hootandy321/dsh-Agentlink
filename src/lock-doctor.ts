import { lstat, opendir } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";

const TASK_ID_PATTERN = /^dsh_[a-f0-9]{12}$/;
const MAX_DIRECTORY_ENTRIES = 64;

export type StructuralPresence = "present" | "missing" | "unreadable" | "not-observed";
export type StructuralPathType = "directory" | "file" | "symbolic-link" | "other" | "missing" | "unreadable" | "not-observed";

export interface LockDiagnostic {
  path: string;
  label: string;
  kind: "registry" | "events";
  taskId?: string;
  presence: StructuralPresence;
  pathType: StructuralPathType;
  ownerPresence: StructuralPresence;
  ownerType: StructuralPathType;
  entriesObserved: number;
  entriesTruncated: boolean;
  entryObservationLimit: number;
  detail: string;
}

export interface LockDiagnostics {
  locks: LockDiagnostic[];
  ledgersPath: string;
  ledgersPresence: StructuralPresence;
  ledgersType: StructuralPathType;
  ledgerEntriesObserved: number;
  ledgerEntriesTruncated: boolean;
  ledgerEntryObservationLimit: number;
  eventsLocksReported: number;
  ledgerScanError?: string;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathTypeOf(stats: Stats): StructuralPathType {
  if (stats.isSymbolicLink()) return "symbolic-link";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

async function observePath(path: string): Promise<{
  presence: StructuralPresence;
  pathType: StructuralPathType;
  error?: string;
}> {
  try {
    const stats = await lstat(path);
    return { presence: "present", pathType: pathTypeOf(stats) };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { presence: "missing", pathType: "missing" };
    return { presence: "unreadable", pathType: "unreadable", error: messageOf(error) };
  }
}

async function observeDirectoryEntries(path: string): Promise<{
  entriesObserved: number;
  entriesTruncated: boolean;
  error?: string;
}> {
  let directory;
  try {
    directory = await opendir(path);
  } catch (error) {
    return { entriesObserved: 0, entriesTruncated: false, error: messageOf(error) };
  }

  let entriesObserved = 0;
  let entriesTruncated = false;
  try {
    for await (const _entry of directory) {
      entriesObserved += 1;
      if (entriesObserved > MAX_DIRECTORY_ENTRIES) {
        entriesTruncated = true;
        break;
      }
    }
  } catch (error) {
    return { entriesObserved, entriesTruncated, error: messageOf(error) };
  } finally {
    await directory.close().catch(() => undefined);
  }
  return { entriesObserved, entriesTruncated };
}

async function diagnoseLock(
  lockDir: string,
  label: string,
  kind: "registry" | "events",
  taskId?: string,
): Promise<LockDiagnostic> {
  const lock = await observePath(lockDir);
  const base = {
    path: lockDir,
    label,
    kind,
    ...(taskId === undefined ? {} : { taskId }),
    presence: lock.presence,
    pathType: lock.pathType,
    ownerPresence: "not-observed" as StructuralPresence,
    ownerType: "not-observed" as StructuralPathType,
    entriesObserved: 0,
    entriesTruncated: false,
    entryObservationLimit: MAX_DIRECTORY_ENTRIES,
  };

  if (lock.presence !== "present" || lock.pathType !== "directory") {
    return {
      ...base,
      detail:
        lock.error === undefined
          ? "point-in-time structural observation only; lock path is not a plain directory"
          : "point-in-time structural observation failed: " + lock.error,
    };
  }

  const owner = await observePath(join(lockDir, "owner.json"));
  const entries = await observeDirectoryEntries(lockDir);
  return {
    ...base,
    ownerPresence: owner.presence,
    ownerType: owner.pathType,
    entriesObserved: entries.entriesObserved,
    entriesTruncated: entries.entriesTruncated,
    detail:
      entries.error === undefined
        ? "point-in-time structural observation only; owner.json content was not read"
        : "point-in-time structural observation was partial: " + entries.error + "; owner.json content was not read",
  };
}

export async function collectLockDiagnostics(homeDir: string): Promise<LockDiagnostics> {
  const locks: LockDiagnostic[] = [
    await diagnoseLock(join(homeDir, "claims", "registry.lock"), "registry.lock", "registry"),
  ];
  const ledgersPath = join(homeDir, "ledgers");
  const ledgers = await observePath(ledgersPath);
  let ledgerEntriesObserved = 0;
  let ledgerEntriesTruncated = false;
  let ledgerScanError: string | undefined;

  if (ledgers.presence === "present" && ledgers.pathType === "directory") {
    let directory;
    try {
      directory = await opendir(ledgersPath);
    } catch (error) {
      ledgerScanError = messageOf(error);
    }

    if (directory !== undefined) {
      try {
        for await (const entry of directory) {
          ledgerEntriesObserved += 1;
          if (ledgerEntriesObserved > MAX_DIRECTORY_ENTRIES) {
            ledgerEntriesTruncated = true;
            break;
          }
          if (entry.isDirectory() && !entry.isSymbolicLink() && TASK_ID_PATTERN.test(entry.name)) {
            locks.push(
              await diagnoseLock(
                join(ledgersPath, entry.name, "events.lock"),
                "events.lock (task " + entry.name + ")",
                "events",
                entry.name,
              ),
            );
          }
        }
      } catch (error) {
        ledgerScanError = messageOf(error);
      } finally {
        await directory.close().catch(() => undefined);
      }
    }
  }

  const combinedScanError = ledgers.error ?? ledgerScanError;
  return {
    locks,
    ledgersPath,
    ledgersPresence: ledgers.presence,
    ledgersType: ledgers.pathType,
    ledgerEntriesObserved,
    ledgerEntriesTruncated,
    ledgerEntryObservationLimit: MAX_DIRECTORY_ENTRIES,
    eventsLocksReported: locks.filter((lock) => lock.kind === "events").length,
    ...(combinedScanError === undefined ? {} : { ledgerScanError: combinedScanError }),
  };
}
