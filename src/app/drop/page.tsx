"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Checkout, Confirmed, PickSeats, QueueView, type SeatMe } from "./seating";
import { posterPhoto } from "@/lib/posters";

interface DropInfo { id: string; name: string; mode: string; status: string; inventory: number; opensAt: string; closesAt: string; commit: string | null; seatSelect?: boolean; instantQueue?: boolean; saleOpensAt?: string | null; entrantCount: number; serverTime: string }
interface MeState extends SeatMe { state: string; dropStatus: string; entry: { publicId: string } | null; allocation: { seatNo: number } | null; rank: number | null }

// Seat-select screens after the draw; these replace the result card and the entry button.
const SEAT_SCREENS = ["waiting", "your_turn", "checkout", "confirmed"];
const FAST_POLL = ["waiting", "your_turn", "checkout"];

const PENDING = "fairdrop.pending"; // { dropId, key } survives refresh so a retry reuses the same Idempotency-Key

function deviceFp(): string {
  const raw = [navigator.userAgent, screen.width, screen.height, Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.language].join("|");
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
  return `web-${(h >>> 0).toString(16)}`;
}

const STATE_TEXT: Record<string, string> = {
  not_entered: "You haven't entered yet.",
  entered: "You're in the draw.",
  under_review: "Your entry is under review.",
  confirmed: "You got a seat!",
  lost: "Not selected this time.",
  missed: "The entry window has closed.",
  not_purchased: "Seats are on sale now.",
  sold_out: "Sold out.",
  turn_expired: "Your turn has ended.",
  waiting: "You're in the queue.",
};

export default function Home() {
  const [user, setUser] = useState<{ email: string } | null | undefined>(undefined);
  const [email, setEmail] = useState("");
  const [drops, setDrops] = useState<{ id: string; name: string; status: string }[]>([]);
  const [dropId, setDropId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropInfo | null>(null);
  const [me, setMe] = useState<MeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const skew = useRef(0);
  const meRef = useRef<MeState | null>(null);
  const [changing, setChanging] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    fetch("/api/me").then(async (r) => setUser(r.ok ? (await r.json()).user : null));
    fetch("/api/drops").then(async (r) => {
      const j = await r.json();
      setDrops(j.drops ?? []);
      const fromUrl = new URLSearchParams(location.search).get("drop");
      setDropId(fromUrl ?? j.drops?.[0]?.id ?? null);
    });
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const write = useCallback(async (id: string, mode: string, key: string) => {
    setBusy(true);
    setError("");
    sessionStorage.setItem(PENDING, JSON.stringify({ dropId: id, key }));
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = await fetch(`/api/drops/${id}/${mode === "lottery" ? "entries" : "purchase"}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-requested-with": "fairdrop", "idempotency-key": key, "x-device-fp": deviceFp() },
          body: "{}",
        });
        const j = await r.json();
        if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 409) || j.error?.code === "WINDOW_CLOSED") {
          sessionStorage.removeItem(PENDING);
          if (!r.ok) setError(j.error?.message ?? j.error?.code);
          break;
        }
        const wait = Number(r.headers.get("retry-after") ?? 1) * 1000;
        await new Promise((res) => setTimeout(res, Math.max(wait, 500 * 2 ** attempt)));
      } catch {
        await new Promise((res) => setTimeout(res, 500 * 2 ** attempt)); // network blip: retry same key
      }
    }
    setBusy(false);
  }, []);

  // Poll drop + my state. On load, replay any write that was in flight when the page was refreshed.
  useEffect(() => {
    if (!dropId) return;
    let stop = false;
    const load = async () => {
      const d = await fetch(`/api/drops/${dropId}`).then((r) => (r.ok ? r.json() : null));
      if (stop || !d) return;
      skew.current = new Date(d.serverTime).getTime() - Date.now();
      setDrop(d);
      if (user) {
        const m = await fetch(`/api/drops/${dropId}/me`).then((r) => (r.ok ? r.json() : null));
        if (!stop && m) { meRef.current = m; setMe(m); }
      }
    };
    // Poll every second while in the queue or buying (and while the draw runs), else every 3s.
    let t: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await load().catch(() => {});
      if (stop) return;
      const m = meRef.current;
      const fast = (m && FAST_POLL.includes(m.state)) || ["closed", "frozen"].includes(m?.dropStatus ?? "");
      t = setTimeout(loop, m?.state === "waiting" ? 700 : fast ? 1000 : 3000);
    };
    loop();
    const pending = JSON.parse(sessionStorage.getItem(PENDING) ?? "null");
    if (user && pending?.dropId === dropId) {
      fetch(`/api/drops/${dropId}`).then((r) => r.json()).then((d) => write(dropId, d.mode, pending.key).then(load));
    }
    return () => { stop = true; clearTimeout(t); };
  }, [dropId, user, write]);

  const refreshMe = useCallback(async () => {
    if (!dropId) return;
    const m = await fetch(`/api/drops/${dropId}/me`).then((r) => (r.ok ? r.json() : null));
    if (m) { meRef.current = m; setMe(m); }
  }, [dropId]);

  const login = async () => {
    const r = await fetch("/api/auth/dev-login", { method: "POST", headers: { "content-type": "application/json", "x-device-fp": deviceFp() }, body: JSON.stringify({ email }) });
    const j = await r.json();
    if (r.ok) setUser(j.user);
    else setError(j.error?.message ?? "login failed");
  };

  const serverNow = now + skew.current;
  const opens = drop ? new Date(drop.opensAt).getTime() : 0;
  const closes = drop ? new Date(drop.closesAt).getTime() : 0;
  const countdown = (ms: number) => `${Math.max(0, Math.floor(ms / 60000))}:${String(Math.max(0, Math.floor(ms / 1000) % 60)).padStart(2, "0")}`;
  const seatFlow = !!(drop?.seatSelect && me && SEAT_SCREENS.includes(me.state));
  const wide = seatFlow && me!.state !== "waiting";
  const canAct = drop && user && drop.status === "open" && me && ["not_entered", "not_purchased"].includes(me.state);

  const STAGES = ["scheduled", "open", "draw", "result"];
  const instant = !!drop?.instantQueue;
  const stage = !drop ? -1
    : instant
      ? drop.status === "scheduled" ? 0 : me?.state === "confirmed" ? 3 : me && ["your_turn", "checkout"].includes(me.state) ? 2 : 1
      : drop.status === "scheduled" ? 0 : drop.status === "open" ? 1 : ["closed", "frozen"].includes(drop.status) ? 2 : 3;
  const STAGE_LABELS = instant ? ["Upcoming", "Queue", "Pick seats", "Tickets"] : ["Upcoming", "Entries open", "Draw", drop?.seatSelect ? "Queue & seats" : "Results"];
  const resultClass = me?.state === "confirmed" ? "win" : me && ["entered", "under_review"].includes(me.state) ? "wait" : "";
  const RESULT_SUB: Record<string, string> = {
    entered: drop?.seatSelect ? "When entries close, a random draw sets everyone's place in the queue." : "Every entry has the same odds, whenever it arrived.",
    sold_out: "Every seat has been sold.",
    turn_expired: "Your time to pick seats ran out.",
    lost: drop?.seatSelect ? "Your entry was removed by the duplicate-account check." : "The draw was random and publicly verifiable.",
    confirmed: "Your seat is confirmed.",
    not_entered: drop?.status === "scheduled" ? "Entries open when the countdown ends."
      : drop?.saleOpensAt && new Date(drop.saleOpensAt).getTime() > serverNow ? `Join now to get your queue number. Sale starts in ${countdown(new Date(drop.saleOpensAt).getTime() - serverNow)}.`
      : "Enter any time before the window closes.",
  };

  return (
    <main style={{ maxWidth: wide ? 1080 : 680 }}>
      <nav className="nav">
        <a href="/" className="brand" style={{ color: "inherit" }}><span className="brand-mark">◆</span>Fair Drop</a>
        {user && <span className="user-chip">{user.email}</span>}
      </nav>

      <a href="/" className="muted" style={{ fontSize: 13, display: "inline-block", marginBottom: 16 }}>← All events</a>

      {!seatFlow && <div className="steps">
        <div className="step"><div className="n">1</div><b>Enter once</b><span>Any time in the window</span></div>
        <div className="step"><div className="n">2</div><b>Fair draw</b><span>Random, committed in advance</span></div>
        <div className="step"><div className="n">3</div><b>Verify it</b><span>Public audit for every draw</span></div>
      </div>}

      {user === null && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="eyebrow">Sign in to take part</div>
          <div className="signin" style={{ marginTop: 10 }}>
            <input placeholder="you@college.edu" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && login()} aria-label="email" />
            <button className="primary" onClick={login}>Continue</button>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Demo sign-in (stands in for email OTP verification)</div>
        </div>
      )}

      {drops.length > 1 && !seatFlow && (
        <div className="row" style={{ marginBottom: 12 }}>
          <select value={dropId ?? ""} onChange={(e) => { setDropId(e.target.value); setMe(null); }} aria-label="drop">
            {drops.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.status}</option>)}
          </select>
        </div>
      )}

      {drop && (
        <div className="panel">
          {posterPhoto(drop.name) && !wide && (
            <div className="drop-banner" style={{ backgroundImage: `linear-gradient(180deg, rgba(0,0,0,0) 40%, rgba(0,0,0,.45)), url(${posterPhoto(drop.name)})` }} />
          )}
          <div className="panel-head">
            <div>
              <div className="eyebrow">{drop.mode === "lottery" ? "Fair lottery · one entry per verified account" : "First come, first served"}</div>
              <h2>{drop.name}</h2>
            </div>
            <span className={`pill ${drop.status === "open" ? "live" : stage === 3 ? "done" : ""}`}>
              {drop.status === "open" && drop.saleOpensAt && new Date(drop.saleOpensAt).getTime() > serverNow ? "Queue open" : drop.status === "open" ? "Live" : drop.status === "scheduled" ? "Upcoming" : drop.status === "claim" ? "On sale" : stage === 3 ? "Drawn" : "Drawing"}
            </span>
          </div>

          {/* Only an upcoming drop shows a clock; once open there is no "time left to enter" pressure. */}
          <div className="tiles" style={drop.status === "scheduled" ? undefined : { gridTemplateColumns: "repeat(2, 1fr)" }}>
            <div className="tile"><div className="v">{drop.inventory}</div><div className="k">seats</div></div>
            <div className="tile"><div className="v">{drop.mode === "lottery" ? drop.entrantCount.toLocaleString() : "–"}</div><div className="k">entries</div></div>
            {drop.status === "scheduled" && (
              <div className="tile"><div className="v">{countdown(opens - serverNow)}</div><div className="k">until open</div></div>
            )}
          </div>

          {drop.mode === "lottery" && (
            <div className="timeline" aria-label="drop progress">
              {STAGES.map((st, i) => <div key={st} className={`tl ${i <= stage ? "on" : ""}`}><i />{STAGE_LABELS[i]}</div>)}
            </div>
          )}

          {seatFlow && me && drop && (
            <div className="seat-flow">
              {me.state === "waiting" && <QueueView me={me} />}
              {(me.state === "your_turn" || (me.state === "checkout" && changing)) && (
                <PickSeats dropId={drop.id} me={me} onHeld={() => { setChanging(false); refreshMe(); }} />
              )}
              {me.state === "checkout" && me.order && !changing && (
                <Checkout dropId={drop.id} order={me.order} onDone={refreshMe} onChange={() => setChanging(true)} />
              )}
              {me.state === "confirmed" && me.order && <Confirmed order={me.order} eventName={drop.name} />}
            </div>
          )}

          {me && !seatFlow && (
            <div className={`result ${resultClass}`}>
              <div className="t">{STATE_TEXT[me.state] ?? me.state}{me.allocation ? ` Seat #${me.allocation.seatNo}` : ""}</div>
              {RESULT_SUB[me.state] && <div className="s">{RESULT_SUB[me.state]}</div>}
            </div>
          )}
          {!user && user !== undefined && <div className="result"><div className="t">Sign in to enter</div></div>}

          {canAct && (
            <button className="primary big-btn" disabled={busy} onClick={() => write(drop.id, drop.mode, crypto.randomUUID()).then(refreshMe)}>
              {busy ? "Submitting…" : drop.mode === "lottery" ? "Enter the queue" : "Buy seat"}
            </button>
          )}
          {drop.mode === "lottery" && drop.status === "open" && !seatFlow && <div className="muted" style={{ fontSize: 12, marginTop: 8, textAlign: "center" }}>No need to hurry: your place in the queue is random, not first-come.</div>}
          {error && <p style={{ color: "var(--critical)" }}>{error}</p>}

          {drop.mode === "lottery" && (
            <div className="fineprint">
              Draw commitment <code>{drop.commit?.slice(0, 24)}…</code> published before entries opened.{" "}
              <a href={`/api/drops/${drop.id}/audit`}>View audit</a>
              {me?.entry && <> · your entry id <code>{me.entry.publicId.slice(0, 12)}…</code></>}
            </div>
          )}
        </div>
      )}
      {drops.length === 0 && <p className="muted">No drops yet.</p>}
    </main>
  );
}
