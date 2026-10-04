"use client";
import { useEffect, useMemo, useRef, useState } from "react";

// Post-draw screens for seat-select drops: queue -> your turn (venue map) -> checkout -> confirmed.
// The server's /me state decides which one shows; these components never guess.

export interface OrderSeat { seatNo: number; section: string; row: string; label: string; price: number }
export interface Order { id: string; status: string; total: number; expiresAt: string; paidAt: string | null; paymentRef: string | null; seats: OrderSeat[] }
export interface SeatMe {
  state: string;
  position?: number;
  ahead?: number;
  etaS?: number;
  turnEndsAt?: string;
  saleOpensAt?: string | null;
  order?: Order;
  queue?: { servingRank: number; total: number; freeSeats: number };
}
interface Venue {
  kind: string;
  width: number;
  height: number;
  stage: { label: string; shape: "rect" | "ellipse"; x: number; y: number; w: number; h: number };
  tiers: { name: string; price: number }[];
}
type SeatRow = [number, string, string, string, number, number, number]; // seat_no, section, row, label, price, x, y

const MAX = 6;
export const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

async function post(path: string, body: unknown) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "fairdrop", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message ?? j.error?.code ?? "request failed");
  return j;
}

/** Eases a number towards its new value so the queue visibly counts down rather than jumping. */
function useTween(target: number, ms = 700) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const cur = Math.round(a + (target - a) * (1 - Math.pow(1 - k, 3)));
      from.current = cur;
      setV(cur);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

export function QueueView({ me }: { me: SeatMe }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  const saleIn = me.saleOpensAt ? new Date(me.saleOpensAt).getTime() - now : 0;
  const ahead = me.ahead ?? 0;
  const first = useRef<number | null>(null);
  if (first.current === null || ahead > first.current) first.current = ahead;
  const shown = useTween(ahead);
  const pct = first.current ? Math.round(100 * (1 - ahead / first.current)) : 100;
  return (
    <div className="queue">
      <div className="eyebrow">You&apos;re in the queue</div>
      {me.position != null && <div className="queue-ticket">Your queue number <b>#{me.position.toLocaleString("en-IN")}</b></div>}
      <div className="queue-num" aria-live="polite">{shown.toLocaleString("en-IN")}</div>
      <div className="queue-sub">{ahead === 1 ? "person" : "people"} ahead of you</div>
      <div className="queue-bar"><i style={{ width: `${pct}%` }} /></div>
      <div className="queue-meta">
        <span>{me.queue?.total ? <>Your place: <b>#{me.position?.toLocaleString("en-IN")}</b> of {me.queue.total.toLocaleString("en-IN")}</> : "Seat selection opens when you reach the front"}</span>
        <span>{saleIn > 0 ? `Sale starts in ${mmss(saleIn)}` : ahead > 0 ? `~${Math.max(1, me.etaS ?? 0)}s to go` : "Almost there…"}</span>
      </div>
      {saleIn > 0 && <div className="sale-wait">Tickets go on sale in <b>{mmss(saleIn)}</b>. Your number is locked in; the queue starts moving the moment the sale opens.</div>}
      <div className="queue-note">Keep this tab open. Your place came from the random draw, so refreshing never loses it.</div>
    </div>
  );
}

function SeatMap({ dropId, selected, toggle, mine }: { dropId: string; selected: number[]; toggle: (s: SeatRow) => void; mine: Set<number> }) {
  const [venue, setVenue] = useState<Venue | null>(null);
  const [seats, setSeats] = useState<SeatRow[]>([]);
  const [taken, setTaken] = useState("");
  const [hover, setHover] = useState<SeatRow | null>(null);

  useEffect(() => {
    let stop = false;
    fetch(`/api/drops/${dropId}/seats?layout=1`).then((r) => r.json()).then((j) => {
      if (stop) return;
      setVenue(j.venue);
      setSeats(j.seats ?? []);
      setTaken(j.taken ?? "");
    });
    const t = setInterval(() => {
      fetch(`/api/drops/${dropId}/seats`).then((r) => (r.ok ? r.json() : null)).then((j) => !stop && j && setTaken(j.taken));
    }, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [dropId]);

  const tierIdx = useMemo(() => new Map(venue?.tiers.map((t, i) => [t.price, i]) ?? []), [venue]);
  if (!venue) return <div className="map-loading">Loading venue…</div>;
  const sel = new Set(selected);
  const free = taken.split("").filter((c) => c === "0").length;

  return (
    <div>
      <div className="legend-row">
        {venue.tiers.map((t, i) => <span key={t.name}><i className={`dot tier-${i}`} />{t.name} {inr(t.price)}</span>)}
        <span><i className="dot taken" />Taken</span>
        <span><i className="dot picked" />Yours</span>
      </div>
      <div className="map-wrap">
        <svg viewBox={`0 0 ${venue.width} ${venue.height}`} className={`venue venue-${venue.kind}`} role="img" aria-label={`${venue.kind} seat map, ${free} seats free`}>
          {venue.stage.shape === "ellipse" ? (
            <>
              <ellipse className="pitch" cx={venue.stage.x + venue.stage.w / 2} cy={venue.stage.y + venue.stage.h / 2} rx={venue.stage.w / 2} ry={venue.stage.h / 2} />
              <rect className="pitch-strip" x={venue.stage.x + venue.stage.w / 2 - 8} y={venue.stage.y + venue.stage.h / 2 - 34} width={16} height={68} rx={2} />
            </>
          ) : (
            <rect className="stage" x={venue.stage.x} y={venue.stage.y} width={venue.stage.w} height={venue.stage.h} rx={10} />
          )}
          <text className="stage-label" x={venue.stage.x + venue.stage.w / 2} y={venue.stage.y + venue.stage.h / 2 + (venue.stage.shape === "ellipse" ? 56 : 5)} textAnchor="middle">{venue.stage.label}</text>
          {seats.map((s) => {
            const [no, , , , price, x, y] = s;
            const isSel = sel.has(no);
            const isTaken = taken[no - 1] === "1" && !isSel && !mine.has(no);
            const cls = isSel ? "seat picked" : isTaken ? "seat taken" : `seat tier-${tierIdx.get(price) ?? 0}`;
            return (
              <circle
                key={no}
                cx={x}
                cy={y}
                r={7.5}
                className={cls}
                onClick={() => !isTaken && toggle(s)}
                onMouseEnter={() => setHover(s)}
                onMouseLeave={() => setHover((h) => (h?.[0] === no ? null : h))}
              />
            );
          })}
        </svg>
      </div>
      <div className="hover-line">
        {hover ? <>{hover[1]} · Row {hover[2]} · Seat {hover[3]} · <b>{inr(hover[4])}</b></> : <span className="muted">{free.toLocaleString("en-IN")} seats left. Tap a seat to pick it.</span>}
      </div>
    </div>
  );
}

export function PickSeats({ dropId, me, onHeld }: { dropId: string; me: SeatMe; onHeld: () => void }) {
  const [picked, setPicked] = useState<SeatRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  const mine = useMemo(() => new Set(me.order?.seats.map((s) => s.seatNo) ?? []), [me.order]);

  const toggle = (s: SeatRow) => {
    setErr("");
    setPicked((p) => {
      if (p.some((x) => x[0] === s[0])) return p.filter((x) => x[0] !== s[0]);
      if (p.length >= MAX) { setErr(`You can pick up to ${MAX} tickets.`); return p; }
      return [...p, s];
    });
  };
  const total = picked.reduce((t, s) => t + s[4], 0);
  const hold = async () => {
    setBusy(true);
    setErr("");
    try {
      await post(`/api/drops/${dropId}/hold`, { seatNos: picked.map((s) => s[0]) });
      onHeld();
    } catch (e) {
      setErr((e as Error).message);
      setPicked([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pick">
      <div className="turn-banner">
        <div>
          <b>It&apos;s your turn!</b>
          <span>Pick up to {MAX} seats. They&apos;re not yours until you hold them.</span>
        </div>
        {me.turnEndsAt && <div className="turn-timer">{mmss(new Date(me.turnEndsAt).getTime() - now)}</div>}
      </div>
      <div className="pick-grid">
        <SeatMap dropId={dropId} selected={picked.map((s) => s[0])} toggle={toggle} mine={mine} />
        <aside className="basket">
          <div className="eyebrow">Your seats ({picked.length}/{MAX})</div>
          {picked.length === 0 && <p className="muted" style={{ fontSize: 13 }}>No seats picked yet.</p>}
          <ul>
            {picked.map((s) => (
              <li key={s[0]}>
                <span><b>{s[3]}</b> <small>{s[1]}</small></span>
                <span>{inr(s[4])} <button className="x" onClick={() => toggle(s)} aria-label={`remove ${s[3]}`}>×</button></span>
              </li>
            ))}
          </ul>
          <div className="basket-total"><span>Total</span><b>{inr(total)}</b></div>
          <button className="primary big-btn" disabled={!picked.length || busy} onClick={hold}>
            {busy ? "Holding seats…" : picked.length ? `Hold ${picked.length} seat${picked.length > 1 ? "s" : ""}` : "Pick seats"}
          </button>
          {err && <p className="err">{err}</p>}
        </aside>
      </div>
    </div>
  );
}

export function Checkout({ dropId, order, onDone, onChange }: { dropId: string; order: Order; onDone: () => void; onChange: () => void }) {
  const [now, setNow] = useState(Date.now());
  const [paying, setPaying] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  const left = new Date(order.expiresAt).getTime() - now;

  const pay = async () => {
    setPaying(true);
    setErr("");
    try {
      await new Promise((r) => setTimeout(r, 1500)); // mock gateway "processing"
      await post(`/api/drops/${dropId}/pay`, { orderId: order.id });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
      setPaying(false);
    }
  };

  return (
    <div className="checkout">
      <div className="hold-banner">
        Seats held for you · <b>{mmss(left)}</b> left to pay
      </div>
      <div className="checkout-grid">
        <div className="card">
          <div className="eyebrow">Order summary</div>
          <ul className="order-lines">
            {order.seats.map((s) => (
              <li key={s.seatNo}><span><b>{s.label}</b> <small>{s.section}</small></span><span>{inr(s.price)}</span></li>
            ))}
          </ul>
          <div className="basket-total"><span>Total</span><b>{inr(order.total)}</b></div>
          <button className="link" onClick={onChange} disabled={paying}>← Change seats</button>
        </div>
        <form className="card pay-form" onSubmit={(e) => { e.preventDefault(); pay(); }}>
          <div className="eyebrow">Payment <span className="test-pill">Test mode</span></div>
          <label>Card number<input defaultValue="4242 4242 4242 4242" inputMode="numeric" autoComplete="off" /></label>
          <div className="row2">
            <label>Expiry<input defaultValue="12/28" autoComplete="off" /></label>
            <label>CVC<input defaultValue="123" autoComplete="off" /></label>
          </div>
          <label>Name on card<input defaultValue="Demo User" autoComplete="off" /></label>
          <button className="primary big-btn" disabled={paying || left <= 0}>
            {paying ? <><span className="spin" /> Processing payment…</> : `Pay ${inr(order.total)}`}
          </button>
          <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>Mock payment: card details stay in your browser and are never sent.</p>
          {err && <p className="err">{err}</p>}
        </form>
      </div>
    </div>
  );
}

/** Deterministic QR-looking pattern so each ticket looks distinct. Not a scannable code. */
function FauxQr({ seed }: { seed: string }) {
  const cells: boolean[] = [];
  let h = 2166136261;
  for (let i = 0; i < 121; i++) {
    h ^= seed.charCodeAt(i % seed.length) + i;
    h = Math.imul(h, 16777619);
    cells.push(((h >>> 0) & 3) === 0 || ((h >>> 3) & 1) === 1);
  }
  // Three corner "finder" squares (3x3 with a hollow centre), random modules elsewhere.
  const corner = (x: number, y: number) => (x < 3 || x > 7) && (y < 3 || y > 7) && !(x > 7 && y > 7);
  const centre = (x: number, y: number) => (x === 1 || x === 9) && (y === 1 || y === 9);
  return (
    <svg viewBox="0 0 11 11" className="qr" aria-hidden="true">
      {cells.map((on, i) => {
        const x = i % 11, y = Math.floor(i / 11);
        const fill = corner(x, y) ? !centre(x, y) : on;
        return fill ? <rect key={i} x={x} y={y} width={1} height={1} /> : null;
      })}
    </svg>
  );
}

export function Confirmed({ order, eventName }: { order: Order; eventName: string }) {
  const [title, venue] = eventName.split("|").map((s) => s.trim());
  return (
    <div className="confirmed">
      <div className="confirm-head">
        <div className="tick">✓</div>
        <div>
          <h3>Your tickets have been confirmed</h3>
          <p>{order.seats.length} ticket{order.seats.length > 1 ? "s" : ""} · {inr(order.total)} paid · ref <code>{order.paymentRef}</code></p>
        </div>
      </div>
      <div className="tickets">
        {order.seats.map((s) => (
          <div className="ticket" key={s.seatNo}>
            <div className="ticket-main">
              <div className="eyebrow">{venue ?? "Admit one"}</div>
              <div className="ticket-title">{title}</div>
              <div className="ticket-seat">
                <div><small>Section</small><b>{s.section}</b></div>
                <div><small>Row</small><b>{s.row}</b></div>
                <div><small>Seat</small><b>{s.label}</b></div>
              </div>
            </div>
            <div className="ticket-stub">
              <FauxQr seed={`${order.id}:${s.seatNo}`} />
              <small>{order.id.slice(0, 8).toUpperCase()}</small>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
