"use client";
import { useState } from "react";

export default function AdminLogin() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const submit = async () => {
    setError("");
    const r = await fetch("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    if (r.ok) location.href = "/dashboard";
    else setError((await r.json().catch(() => ({}))).error?.message ?? "login failed");
  };
  return (
    <main style={{ maxWidth: 420 }}>
      <nav className="nav"><a href="/" className="brand" style={{ color: "inherit" }}><span className="brand-mark">◆</span>Fair Drop</a></nav>
      <div className="panel">
        <div className="eyebrow">Organiser sign-in</div>
        <div className="signin" style={{ marginTop: 10 }}>
          <input type="password" placeholder="Admin token" value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} aria-label="admin token" autoComplete="current-password" />
          <button className="primary" onClick={submit}>Continue</button>
        </div>
        {error && <p style={{ color: "var(--critical)", fontSize: 13 }}>{error}</p>}
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Sets an HttpOnly cookie for 8 hours. The token is never placed in the URL.</p>
      </div>
    </main>
  );
}
