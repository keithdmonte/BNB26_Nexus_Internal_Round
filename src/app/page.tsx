"use client";
import { useEffect, useState } from "react";

interface Ev { id: string; name: string; mode: string; status: string; inventory: number; opens_at: string; closes_at: string; entries: number; sold: number }

// "Title | Venue | Category" packed into the drop name keeps the schema unchanged.
function parse(name: string) {
  const [title, venue, category] = name.split("|").map((x) => x.trim());
  return { title, venue: venue ?? "Online", category: category ?? "Event" };
}

const POSTERS = [
  ["#2a78d6", "#7b3fe4"], ["#eb6834", "#d03b6b"], ["#1baf7a", "#2a78d6"], ["#eda100", "#eb6834"], ["#7b3fe4", "#e87ba4"], ["#0d366b", "#1baf7a"],
];
function poster(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return POSTERS[Math.abs(h) % POSTERS.length];
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}:${String(r).padStart(2, "0")}`;
};

export default function Events() {
  const [events, setEvents] = useState<Ev[] | null>(null);
  const [skew, setSkew] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [filter, setFilter] = useState("All");

  useEffect(() => {
    const load = () =>
      fetch("/api/drops").then(async (r) => {
        const j = await r.json();
        setSkew(new Date(j.serverTime).getTime() - Date.now());
        setEvents(j.drops ?? []);
      });
    load();
    const a = setInterval(load, 3000);
    const b = setInterval(() => setNow(Date.now()), 250);
    return () => { clearInterval(a); clearInterval(b); };
  }, []);

  const t = now + skew;
  const cats = ["All", ...new Set((events ?? []).map((e) => parse(e.name).category))];
  const shown = (events ?? []).filter((e) => filter === "All" || parse(e.name).category === filter);
  const live = shown.filter((e) => e.status === "open");

  return (
    <main style={{ maxWidth: 1120 }}>
      <nav className="nav">
        <div className="brand"><span className="brand-mark">◆</span>Fair Drop</div>
        <span className="user-chip">Fair tickets. No bots. No refresh wars.</span>
      </nav>

      <section className="hero">
        <h1>Upcoming drops</h1>
        <p>Pick an event and enter any time while the window is open. Everyone gets equal odds in a draw anyone can verify.</p>
      </section>

      <div className="chips">
        {cats.map((c) => <button key={c} className={`chip ${filter === c ? "on" : ""}`} onClick={() => setFilter(c)}>{c}</button>)}
        {live.length > 0 && <span className="pill live" style={{ marginLeft: "auto" }}>{live.length} live now</span>}
      </div>

      {events === null && <p className="muted">Loading events…</p>}
      {events && shown.length === 0 && <p className="muted">No events yet. Create one from the dashboard.</p>}

      <div className="events">
        {shown.map((e) => {
          const p = parse(e.name);
          const [c1, c2] = poster(e.id);
          const opens = new Date(e.opens_at).getTime(), closes = new Date(e.closes_at).getTime();
          const isLive = e.status === "open";
          const drawn = ["drawn", "claim", "done"].includes(e.status);
          const status = e.status === "scheduled" ? { label: `Tickets drop in ${fmt(opens - t)}`, cls: "soon" }
            : isLive ? { label: `Live · closes in ${fmt(closes - t)}`, cls: "live" }
            : drawn ? { label: e.mode === "lottery" ? "Results out" : "Sold out", cls: "done" }
            : { label: "Drawing winners…", cls: "soon" };
          const progress = e.status === "scheduled" ? 0 : isLive ? Math.min(1, (t - opens) / (closes - opens)) : 1;
          return (
            <a key={e.id} href={`/drop?drop=${e.id}`} className="ev">
              <div className="ev-poster" style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}>
                <span className="ev-cat">{p.category}</span>
                <span className="ev-title">{p.title}</span>
                {isLive && <span className="ev-live">● LIVE</span>}
              </div>
              <div className="ev-body">
                <div className="ev-venue">{p.venue}</div>
                <div className={`ev-status ${status.cls}`}>{status.label}</div>
                <div className="ev-bar"><i style={{ width: `${progress * 100}%` }} /></div>
                <div className="ev-meta">
                  <span>{e.inventory} seats</span>
                  <span>{e.mode === "lottery" ? `${e.entries.toLocaleString()} entered` : `${e.sold} sold`}</span>
                  <span>{e.mode === "lottery" ? "Fair draw" : "First come"}</span>
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </main>
  );
}
