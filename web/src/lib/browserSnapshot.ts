const PREFIX = 'blockcraft:browser-snapshot:v1:';

interface SnapshotEnvelope<T> {
  version: 1;
  savedAt: number;
  data: T;
}

/** Read the last successful page response synchronously so cached screens paint before revalidation. */
export function readBrowserSnapshot<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(`${PREFIX}${key}`);
    if (!raw) return null;
    const envelope = JSON.parse(raw) as SnapshotEnvelope<T>;
    if (envelope.version !== 1 || !('data' in envelope)) return null;
    return envelope.data;
  } catch {
    return null;
  }
}

/** Storage is best-effort: a full or disabled browser storage must not break the live page. */
export function writeBrowserSnapshot<T>(key: string, data: T): void {
  try {
    const envelope: SnapshotEnvelope<T> = { version: 1, savedAt: Date.now(), data };
    window.localStorage.setItem(`${PREFIX}${key}`, JSON.stringify(envelope));
  } catch {
    // Keep the in-memory data usable when browser storage is unavailable.
  }
}

export function removeBrowserSnapshot(key: string): void {
  try {
    window.localStorage.removeItem(`${PREFIX}${key}`);
  } catch {
    // Ignore unavailable browser storage.
  }
}

/** Clear cached page data on logout without touching theme, layout, or other preferences. */
export function clearBrowserSnapshots(): void {
  try {
    const prefixes = [PREFIX, 'blockcraft:backups:v'];
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) window.localStorage.removeItem(key);
    }
  } catch {
    // The app can still continue when browser storage is unavailable.
  }
}
