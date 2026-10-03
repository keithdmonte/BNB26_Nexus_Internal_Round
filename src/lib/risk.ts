// Pre-draw clustering (docs/ABUSE_DEFENSE.md D6). Reads request/account metadata only.
// MUST NOT read sim_labels: detection has to work without ground truth.

export interface RiskInput {
  entryId: string;
  publicId: string;
  deviceFp: string | null;
  signupIp: string | null;
  accountCreatedAt: Date;
}

export interface RiskDecision {
  entryId: string;
  status: "active" | "collapsed" | "excluded";
  clusterId: string | null;
  reason: string | null;
}

export const FRESH_ACCOUNT_MS = 24 * 3600 * 1000;
export const SUBNET_MIN_CLUSTER = 3;

function subnet24(ip: string | null): string | null {
  if (!ip) return null;
  const m = ip.match(/^(\d+\.\d+\.\d+)\.\d+/);
  return m ? m[1] : null;
}

/**
 * Links entries that share a device fingerprint, or that are fresh accounts (created < 24h before the
 * drop opened) registered from the same /24. Shared IP alone never links old accounts: campus NAT.
 * `collapse` keeps one entry per cluster (lowest publicId, i.e. arbitrary but deterministic);
 * `exclude` drops the whole cluster.
 */
export function scoreEntries(
  entries: RiskInput[],
  opensAt: Date,
  policy: "collapse" | "exclude" = "collapse",
): RiskDecision[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const e of entries) parent.set(e.entryId, e.entryId);

  const groups = new Map<string, { reason: string; ids: string[] }>();
  const add = (k: string, reason: string, id: string) => {
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { reason, ids: [] }));
    g.ids.push(id);
  };
  for (const e of entries) {
    if (e.deviceFp) add(`fp:${e.deviceFp}`, "shared_device", e.entryId);
    const net = subnet24(e.signupIp);
    if (net && opensAt.getTime() - e.accountCreatedAt.getTime() < FRESH_ACCOUNT_MS) add(`net:${net}`, "fresh_accounts_same_subnet", e.entryId);
  }
  const reasons = new Map<string, Set<string>>();
  for (const [k, g] of groups) {
    const min = k.startsWith("fp:") ? 2 : SUBNET_MIN_CLUSTER;
    if (g.ids.length < min) continue;
    for (const id of g.ids.slice(1)) union(g.ids[0], id);
    for (const id of g.ids) {
      if (!reasons.has(id)) reasons.set(id, new Set());
      reasons.get(id)!.add(g.reason);
    }
  }

  const clusters = new Map<string, RiskInput[]>();
  for (const e of entries) {
    if (!reasons.has(e.entryId)) continue;
    const r = find(e.entryId);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r)!.push(e);
  }

  const out = new Map<string, RiskDecision>();
  for (const e of entries) out.set(e.entryId, { entryId: e.entryId, status: "active", clusterId: null, reason: null });
  for (const [root, members] of clusters) {
    if (members.length < 2) continue;
    const keep = members.reduce((a, b) => (a.publicId < b.publicId ? a : b));
    for (const m of members) {
      const reason = [...reasons.get(m.entryId)!].sort().join(",");
      if (policy === "collapse" && m.entryId === keep.entryId) {
        out.set(m.entryId, { entryId: m.entryId, status: "active", clusterId: root, reason: null });
      } else {
        out.set(m.entryId, { entryId: m.entryId, status: policy === "collapse" ? "collapsed" : "excluded", clusterId: root, reason });
      }
    }
  }
  return [...out.values()];
}
