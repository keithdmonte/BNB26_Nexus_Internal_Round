import { pool, tx } from "@/lib/db";
import { invalidateDrop } from "@/lib/drops";
import { draw, freeze } from "@/lib/lottery";

// In-process replacement for the worker (Lean MVP). Every step re-checks status under an
// advisory lock, so running two instances or ticking twice is harmless.

async function transition(id: string, from: string, to: string, timeCol: "opens_at" | "closes_at") {
  await tx(async (c) => {
    const l = await c.query("SELECT pg_try_advisory_xact_lock(hashtext('drop:' || $1)) AS ok", [id]);
    if (!l.rows[0].ok) return;
    // UPDATE waits for in-flight entry inserts (they hold FOR SHARE on the drop row): no late commits.
    await c.query(`UPDATE drops SET status = $3 WHERE id = $1 AND status = $2 AND ${timeCol} <= now()`, [id, from, to]);
  });
  invalidateDrop(id);
}

export async function tick() {
  const { rows } = await pool().query(
    `SELECT id, mode, status, opens_at <= now() AS should_open, closes_at <= now() AS should_close
     FROM drops WHERE status IN ('scheduled', 'open', 'closed', 'frozen')`,
  );
  for (const d of rows) {
    try {
      if (d.status === "scheduled" && d.should_open) await transition(d.id, "scheduled", "open", "opens_at");
      else if (d.status === "open" && d.should_close)
        await transition(d.id, "open", d.mode === "lottery" ? "closed" : "done", "closes_at");
      else if (d.status === "closed") await freeze(d.id);
      else if (d.status === "frozen") await draw(d.id);
    } catch (e) {
      console.error(`[scheduler] drop ${d.id} (${d.status}) failed:`, (e as Error).message);
    }
  }
}

const g = globalThis as unknown as { __schedulerStarted?: boolean };

export function startScheduler(intervalMs = 200) {
  if (g.__schedulerStarted) return;
  g.__schedulerStarted = true;
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (e) {
      console.error("[scheduler] tick failed:", (e as Error).message);
    } finally {
      running = false;
    }
  }, intervalMs);
  console.log("[scheduler] started");
}
