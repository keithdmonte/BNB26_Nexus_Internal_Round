import { randomUUID } from "node:crypto";
import { tx } from "@/lib/db";
import { ApiError, json, requireSim, route } from "@/lib/http";
import { issueSession } from "@/lib/session";

export const dynamic = "force-dynamic";

interface Acct { actorType: string; operatorId?: string; deviceFp?: string; signupIp?: string; ageS?: number; phone?: string }

// Bulk-creates verified sim accounts (phone pre-verified when given; one account per number still holds) and writes their ground-truth labels in one transaction.
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  requireSim(req);
  const { id: runId } = await params;
  const { accounts } = (await req.json()) as { accounts: Acct[] };
  if (!Array.isArray(accounts) || accounts.length === 0 || accounts.length > 10_000) throw new ApiError(400, "VALIDATION", "1..10000 accounts");
  const ids = accounts.map(() => randomUUID());
  await tx(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, verified_at, created_at, signup_ip, device_fp, phone, phone_verified_at, is_sim)
       SELECT x.id, 'sim-' || x.id || '@sim.fairdrop', now(), now() - make_interval(secs => x.age), x.ip::inet, x.fp,
              x.phone, CASE WHEN x.phone IS NULL THEN NULL ELSE now() END, true
       FROM unnest($1::uuid[], $2::float8[], $3::text[], $4::text[], $5::text[]) AS x(id, age, ip, fp, phone)`,
      [ids, accounts.map((a) => a.ageS ?? 30 * 86400), accounts.map((a) => a.signupIp ?? null), accounts.map((a) => a.deviceFp ?? null),
        accounts.map((a) => a.phone ?? null)],
    );
    await c.query(
      `INSERT INTO sim_labels (run_id, user_id, actor_type, operator_id)
       SELECT $1, x.id, x.t, x.op FROM unnest($2::uuid[], $3::text[], $4::text[]) AS x(id, t, op)`,
      [runId, ids, accounts.map((a) => a.actorType), accounts.map((a) => a.operatorId ?? null)],
    );
  });
  const tokens = await Promise.all(ids.map((id) => issueSession(id, true)));
  return json({ accounts: ids.map((userId, i) => ({ userId, token: tokens[i] })) }, 201);
});
