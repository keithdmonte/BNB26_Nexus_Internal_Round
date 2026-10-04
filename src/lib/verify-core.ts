// Pure audit verification shared by scripts/verify.ts and the tests. Needs only the public audit JSON
// plus (for drand draws) an independent way to fetch the committed round.
import { commitOf, computeSeed, entriesHash, rankEntries, RANK_FN_VERSION } from "@/lib/draw-core";
import { verifyBeacon, type Beacon } from "@/lib/beacon";

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface AuditJson {
  rankFnVersion: string;
  status: string;
  commit: string;
  secret?: string;
  entriesHash?: string;
  eligibleCount?: number;
  eligiblePublicIds?: string[];
  seed?: string;
  inventory: number;
  winners?: { rank: number; publicId: string }[];
  beacon?: { source: string; status: string; round: number | null; value: string; signature: string | null };
}

export async function verifyAudit(a: AuditJson, fetchRound: (round: number) => Promise<Beacon>): Promise<{ checks: Check[]; notice: string | null }> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  let notice: string | null = null;

  check("rank function version", a.rankFnVersion === RANK_FN_VERSION, a.rankFnVersion);
  check("draw has happened", typeof a.secret === "string" && a.secret.length === 64, a.status);
  if (!a.secret || !a.entriesHash || !a.eligiblePublicIds || !a.winners) return { checks, notice };

  check("secret matches pre-published commit", commitOf(a.secret) === a.commit);
  check("entries hash matches published entry list", entriesHash(a.eligiblePublicIds) === a.entriesHash, `${a.eligiblePublicIds.length} entries`);
  check("eligible count matches list", a.eligiblePublicIds.length === a.eligibleCount);

  const b = a.beacon;
  const value = b?.value ?? "";
  if (b?.status === "drand") {
    if (b.round == null || !b.signature) {
      check("drand beacon present", false, "status drand but round/signature missing");
    } else {
      const own = verifyBeacon({ round: b.round, randomness: value, signature: b.signature });
      check("drand beacon signature valid (BLS, quicknet key)", own.ok, own.reason ?? `round ${b.round}`);
      try {
        const fetched = await fetchRound(b.round);
        check("drand round matches independent fetch", fetched.randomness === value, `round ${b.round}`);
      } catch (e) {
        check("drand round matches independent fetch", false, `could not fetch round ${b.round}: ${(e as Error).message}`);
      }
    }
  } else {
    if (value !== "") check("no beacon value when no beacon was used", false, `status ${b?.status ?? "none"} but value present`);
    notice =
      b?.status === "fallback"
        ? `beacon: none (fallback). drand round ${b.round} was unreachable at draw time; this draw is commit-reveal only.`
        : b?.status === "disabled"
          ? "beacon: none (disabled). This draw is commit-reveal only."
          : "beacon: none (draw predates drand integration). This draw is commit-reveal only.";
  }

  const seed = computeSeed(a.secret, a.entriesHash, value);
  check("seed = SHA256(secret || entriesHash || beacon)", seed === a.seed);
  const expected = rankEntries(seed, a.eligiblePublicIds).slice(0, a.inventory).map((r) => r.publicId);
  const got = [...a.winners].sort((x, y) => x.rank - y.rank).map((w) => w.publicId);
  check("winners = top-N of recomputed ranking", expected.length === got.length && expected.every((p, i) => p === got[i]), `${got.length} winners`);
  check("no duplicate winners", new Set(got).size === got.length);
  check("winners <= inventory", got.length <= a.inventory, `${got.length}/${a.inventory}`);
  return { checks, notice };
}
