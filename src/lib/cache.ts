// Tiny single-flight TTL cache for hot read endpoints (single instance, like the drop cache).
// Concurrent callers during a refresh share one in-flight query instead of stampeding Postgres.
const g = globalThis as unknown as { __ttlCache?: Map<string, { at: number; value?: unknown; pending?: Promise<unknown> }> };
const store = (g.__ttlCache ??= new Map());

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && "value" in hit && now - hit.at < ttlMs) return hit.value as T;
  if (hit?.pending) return hit.pending as Promise<T>;
  const pending = fn().then(
    (value) => {
      store.set(key, { at: Date.now(), value });
      return value;
    },
    (e) => {
      store.delete(key);
      throw e;
    },
  );
  store.set(key, { ...(hit ?? { at: 0 }), pending });
  return pending;
}

export function clearCache() {
  store.clear();
}
