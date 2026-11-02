import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SyncState {
  /** event key ($insert_id) -> Mixpanel processing time (ms) for every event already applied */
  processed: Record<string, number>;
  /** Mixpanel identity (distinct_id / $user_id) -> email */
  emails: Record<string, string>;
  lastRunAt?: string;
}

export function emptyState(): SyncState {
  return { processed: {}, emails: {} };
}

export function loadState(path: string): SyncState {
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as Partial<SyncState>;
    return { processed: s.processed ?? {}, emails: s.emails ?? {}, lastRunAt: s.lastRunAt };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw err;
  }
}

/** Atomic write (tmp file + rename). */
export function saveState(path: string, state: SyncState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
}

/** Forget processed keys older than the re-scan window; they can never be exported again by a poll. */
export function pruneState(state: SyncState, olderThanMs: number): void {
  for (const [k, t] of Object.entries(state.processed)) if (t < olderThanMs) delete state.processed[k];
}
