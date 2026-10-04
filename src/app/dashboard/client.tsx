"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export function AutoRefresh({ ms }: { ms: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), ms);
    return () => clearInterval(t);
  }, [router, ms]);
  return null;
}

export function DemoControls({ token, drops }: { token: string; drops: { id: string; name: string; status: string }[] }) {
  const [mode, setMode] = useState("lottery");
  const [inventory, setInventory] = useState(5);
  const [windowS, setWindowS] = useState(120);
  const [msg, setMsg] = useState("");
  const admin = async (path: string, body?: unknown) => {
    const r = await fetch(path, { method: "POST", headers: { "x-admin-token": token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    setMsg(r.ok ? `ok ${j.id ?? ""}` : `error ${j.error?.code ?? r.status}`);
  };
  return (
    <div className="card">
      <div className="row">
        <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="mode">
          <option value="lottery">lottery (Fair Drop)</option>
          <option value="fcfs">fcfs (naive)</option>
        </select>
        <label className="secondary">seats <input type="number" value={inventory} min={1} onChange={(e) => setInventory(Number(e.target.value))} style={{ width: 80 }} /></label>
        <label className="secondary">window s <input type="number" value={windowS} min={10} onChange={(e) => setWindowS(Number(e.target.value))} style={{ width: 80 }} /></label>
        <button className="primary" onClick={() => admin("/api/admin/drops", { name: `Live Demo Drop | Main Stage | ${mode === "lottery" ? "Fair Draw" : "First Come"}`, mode, inventory, windowS, opensInS: 15, config: { rateLimit: true, risk: mode === "lottery" } })}>
          Create live drop (opens in 15s)
        </button>
        <span className="muted">{msg}</span>
      </div>
      {drops.filter((d) => ["scheduled", "open"].includes(d.status)).map((d) => (
        <div className="row" key={d.id} style={{ marginTop: 8 }}>
          <span>{d.name} <span className="muted">({d.status})</span></span>
          {d.status === "scheduled" && <button onClick={() => admin(`/api/admin/drops/${d.id}/open`)}>Open now</button>}
          {d.status === "open" && <button onClick={() => admin(`/api/admin/drops/${d.id}/close`)}>Close &amp; draw now</button>}
        </div>
      ))}
    </div>
  );
}
