import type pg from "pg";
import { createDrop } from "@/lib/drops";

// Demo events for the listing page. "Title | Venue | Category" is parsed by the home page.
export const DEMO_EVENTS = [
  { name: "Bit N Build Finale Showcase | CRCE Auditorium, Bandra | Tech", inventory: 120 },
  { name: "Neon Nights Music Festival | Jio World Garden, Mumbai | Music", inventory: 500 },
  { name: "Campus Comedy Night | NCPA, Nariman Point | Comedy", inventory: 200 },
  { name: "Monsoon Cup Cricket Final | Wankhede Stadium | Sports", inventory: 800 },
];

export interface DemoOptions {
  firstOpenInS: number; // seconds from now until the first event opens
  gapS: number; // seconds between successive openings
  windowS: number; // entry window length per event
  hideOld: boolean; // hide previously created (non-simulator) drops from the listing
}

/** Creates fresh demo events relative to now. Caller owns the transaction. */
export async function seedDemo(c: pg.ClientBase, o: DemoOptions) {
  let hidden = 0;
  if (o.hideOld) {
    const r = await c.query(
      `UPDATE drops d SET config = d.config || '{"hidden": true}'
       WHERE NOT (d.config ? 'hidden') AND NOT EXISTS (SELECT 1 FROM sim_runs r WHERE r.drop_id = d.id)`,
    );
    hidden = r.rowCount ?? 0;
  }
  const now = Date.now();
  const created = [];
  for (const [i, e] of DEMO_EVENTS.entries()) {
    const opensAt = new Date(now + (o.firstOpenInS + i * o.gapS) * 1000);
    const closesAt = new Date(opensAt.getTime() + o.windowS * 1000);
    const id = await createDrop(c, { name: e.name, mode: "lottery", inventory: e.inventory, opensAt, closesAt, config: { rateLimit: true, risk: true, demo: true } });
    created.push({ id, name: e.name, opensAt, closesAt });
  }
  return { hidden, created };
}
