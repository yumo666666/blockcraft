/** 按 key 串行化：同一实例的启停/备份/删除不会互相打架（修 v1 的 TOCTOU 双启） */
const chains = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export function isLocked(key: string): boolean {
  return chains.has(key);
}
