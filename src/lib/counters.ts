// Live per-drop counters (single instance). Snapshotted into metric_snapshots by the scheduler.
const g = globalThis as unknown as { __counters?: Map<string, Record<string, number>> };
const counters = (g.__counters ??= new Map());

export function inc(dropId: string, name: string, by = 1) {
  let c = counters.get(dropId);
  if (!c) counters.set(dropId, (c = {}));
  c[name] = (c[name] ?? 0) + by;
}

export function snapshot(dropId: string): Record<string, number> {
  return { ...(counters.get(dropId) ?? {}) };
}

export function activeCounterDrops(): string[] {
  return [...counters.keys()];
}
