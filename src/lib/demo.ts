import type pg from "pg";
import { createDrop } from "@/lib/drops";

// Demo events for the listing page. "Title | Venue | Category" is parsed by the home page; the category
// picks the seat map (Sports = stadium, Music = arena, anything else = theatre).
// openInS: seconds from seeding until the queue opens (0 = now). saleInS: the queue is open but the sale
// starts this many seconds later; joiners get first-come-first-served numbers until then.
export const DEMO_EVENTS = [
  { name: "Coldplay: Music of the Spheres World Tour | DY Patil Stadium, Navi Mumbai | Music", inventory: 800, openInS: 0 },
  { name: "India vs Pakistan · ICC Champions Trophy | Narendra Modi Stadium, Ahmedabad | Sports", inventory: 800, openInS: 0 },
  { name: "Mumbai Indians vs Chennai Super Kings · IPL | Wankhede Stadium, Mumbai | Sports", inventory: 800, openInS: 0 },
  { name: "Arijit Singh Live in Concert | NSCI Dome, Mumbai | Music", inventory: 500, openInS: 0 },
  { name: "Zakir Khan: Mannpasand | NCPA Tata Theatre, Mumbai | Comedy", inventory: 200, openInS: 0 },
  { name: "Bit N Build Finale Showcase | CRCE Auditorium, Bandra | Tech", inventory: 120, openInS: 0 },
  { name: "Diljit Dosanjh: Dil-Luminati Tour | Jio World Garden, Mumbai | Music", inventory: 600, openInS: 0, saleInS: 120 },
  { name: "Sunburn Arena ft. Martin Garrix | Mahalaxmi Racecourse, Mumbai | Music", inventory: 600, openInS: 0, saleInS: 420 },
  { name: "The Phantom of the Opera | Royal Opera House, Mumbai | Theatre", inventory: 150, openInS: 0, saleInS: 900 },
  // Queue open now, sale later: joiners get their number immediately and wait for the sale to start.
  { name: "Ed Sheeran: +-=÷× Mathematics Tour | Mahalaxmi Racecourse, Mumbai | Music", inventory: 600, openInS: 0, saleInS: 300 },
  { name: "India vs Australia · Border-Gavaskar Test | Wankhede Stadium, Mumbai | Sports", inventory: 800, openInS: 0, saleInS: 600 },
  { name: "Anubhav Singh Bassi: Kisi Ko Batana Mat | St. Andrew's Auditorium, Bandra | Comedy", inventory: 250, openInS: 0, saleInS: 1200 },
  { name: "A.R. Rahman Live: Wonderment Tour | DY Patil Stadium, Navi Mumbai | Music", inventory: 800, openInS: 0, saleInS: 3600 },
];

export interface DemoOptions {
  firstOpenInS: number; // seconds from now until the first event opens
  gapS: number; // seconds between successive openings
  windowS: number; // entry window length per event
  hideOld: boolean; // hide previously created (non-simulator) drops from the listing
  only?: string; // create just the events whose name contains this text
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
    if (o.only && !e.name.toLowerCase().includes(o.only.toLowerCase())) continue;
    const opensAt = new Date(now + (o.firstOpenInS + e.openInS + i * o.gapS) * 1000);
    const closesAt = new Date(opensAt.getTime() + o.windowS * 1000);
    const id = await createDrop(c, { name: e.name, mode: "lottery", inventory: e.inventory, opensAt, closesAt, config: {
        rateLimit: true, risk: true, demo: true, seatSelect: true, instantQueue: true, queueWaitS: 10,
        bots: Math.max(300, Math.round(e.inventory * 1.5)),
        ...("saleInS" in e && e.saleInS ? { saleOpensAt: new Date(opensAt.getTime() + e.saleInS * 1000).toISOString() } : {}),
      } });
    created.push({ id, name: e.name, opensAt, closesAt });
  }
  return { hidden, created };
}
