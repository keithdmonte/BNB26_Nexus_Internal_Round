"use client";
import { useCallback, useEffect, useRef, useState } from "react";

interface DropInfo { id: string; name: string; mode: string; status: string; inventory: number; opensAt: string; closesAt: string; commit: string | null; entrantCount: number; serverTime: string }
interface MeState { state: string; dropStatus: string; entry: { publicId: string } | null; allocation: { seatNo: number } | null; rank: number | null }

const PENDING = "fairdrop.pending"; // { dropId, key } survives refresh so a retry reuses the same Idempotency-Key

function deviceFp(): string {
  const raw = [navigator.userAgent, screen.width, screen.height, Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.language].join("|");
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
  return `web-${(h >>> 0).toString(16)}`;
}

const STATE_TEXT: Record<string, string> = {
  not_entered: "You haven't entered yet.",
  entered: "You're in the draw. Entering early gives no advantage. Results appear here after the window closes.",
  under_review: "Your entry is under review.",
  confirmed: "You got a seat!",
  lost: "Not selected this time.",
  missed: "The entry window has closed.",
  not_purchased: "Seats are on sale now.",
  sold_out: "Sold out.",
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
        if (!stop && m) setMe(m);
      }
    };
    load();
    const t = setInterval(load, 3000);
    const pending = JSON.parse(sessionStorage.getItem(PENDING) ?? "null");
    if (user && pending?.dropId === dropId) {
      fetch(`/api/drops/${dropId}`).then((r) => r.json()).then((d) => write(dropId, d.mode, pending.key).then(load));
    }
    return () => { stop = true; clearInterval(t); };
  }, [dropId, user, write]);

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
  const canAct = drop && user && drop.status === "open" && me && ["not_entered", "not_purchased"].includes(me.state);

  return (
    <main style={{ maxWidth: 640 }}>
      <h1>Fair Drop</h1>
      <p className="secondary">High-demand drops where bots can&apos;t win by being faster.</p>

      {user === null && (
        <div className="card row">
          <input placeholder="you@college.edu" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="email" />
          <button className="primary" onClick={login}>Sign in</button>
          <span className="muted" style={{ fontSize: 12 }}>Demo sign-in (stands in for email OTP)</span>
        </div>
      )}
      {user && <p className="muted">Signed in as {user.email}</p>}

      {drops.length > 1 && (
        <div className="row" style={{ margin: "12px 0" }}>
          <select value={dropId ?? ""} onChange={(e) => { setDropId(e.target.value); setMe(null); }} aria-label="drop">
            {drops.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.status})</option>)}
          </select>
        </div>
      )}

      {drop && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="muted" style={{ fontSize: 12 }}>{drop.mode === "lottery" ? "Lottery: one entry per verified account, equal odds" : "First come, first served"}</div>
          <h2 style={{ margin: "4px 0" }}>{drop.name}</h2>
          <div className="secondary">{drop.inventory} seats · status <b>{drop.status}</b>{drop.mode === "lottery" ? ` · ${drop.entrantCount} entries` : ""}</div>
          {drop.status === "scheduled" && <div className="stat"><div className="v">{countdown(opens - serverNow)}</div><div className="k">until the window opens</div></div>}
          {drop.status === "open" && <div className="stat"><div className="v">{countdown(closes - serverNow)}</div><div className="k">left to {drop.mode === "lottery" ? "enter. No need to hurry." : "buy"}</div></div>}

          {me && <p style={{ fontSize: 18, fontWeight: 600 }}>{STATE_TEXT[me.state] ?? me.state}{me.allocation ? ` Seat #${me.allocation.seatNo}.` : ""}</p>}
          {canAct && (
            <button className="primary" disabled={busy} onClick={() => write(drop.id, drop.mode, crypto.randomUUID())}>
              {busy ? "Submitting…" : drop.mode === "lottery" ? "Enter the draw" : "Buy seat"}
            </button>
          )}
          {error && <p style={{ color: "var(--critical)" }}>{error}</p>}
          {drop.mode === "lottery" && (
            <p className="muted" style={{ fontSize: 12 }}>
              Draw commitment <code>{drop.commit}</code>. After the draw, anyone can re-check it at <a href={`/api/drops/${drop.id}/audit`}>the audit</a>.
              {me?.entry && <> Your entry id <code>{me.entry.publicId.slice(0, 16)}…</code></>}
            </p>
          )}
        </div>
      )}
      {drops.length === 0 && <p className="muted">No drops yet.</p>}
    </main>
  );
}
