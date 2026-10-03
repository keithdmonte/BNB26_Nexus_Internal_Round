import { tx } from "@/lib/db";
import { createDrop, type DropMode } from "@/lib/drops";
import { json, requireSim, route } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  requireSim(req);
  const b = (await req.json()) as {
    scenario: string; seed: number;
    config: { mode: DropMode; inventory: number; windowS: number; leadS: number; defenses: Record<string, unknown> };
  };
  const { mode, inventory, windowS, leadS, defenses } = b.config;
  const opensAt = new Date(Date.now() + leadS * 1000);
  const closesAt = new Date(opensAt.getTime() + windowS * 1000);
  const out = await tx(async (c) => {
    const dropId = await createDrop(c, { name: `${b.scenario} (seed ${b.seed})`, mode, inventory, opensAt, closesAt, config: defenses });
    const { rows } = await c.query(
      "INSERT INTO sim_runs (scenario, seed, config, drop_id) VALUES ($1, $2, $3, $4) RETURNING id",
      [b.scenario, b.seed, b.config, dropId],
    );
    return { runId: rows[0].id, dropId };
  });
  return json({ ...out, opensAt, closesAt }, 201);
});
