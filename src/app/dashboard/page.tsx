import { pool } from "@/lib/db";
import { checkIntegrity } from "@/lib/integrity";
import { snapshot } from "@/lib/counters";
import { AutoRefresh, DemoControls } from "./client";

export const dynamic = "force-dynamic";

interface Summary {
  botAccountShare: number | null;
  botSeatShare: number | null;
  advantageMultiplier: number | null;
  humansWonNothing?: boolean;
  humanSuccessRate: number | null;
  pWinHuman?: number | null;
  pWinBot?: number | null;
  humanFalseFlagRate: number | null;
  botFlagRecall: number | null;
  oversell: number;
  duplicateUsers: number;
  integrityOk: boolean;
}
interface Report {
  scenario: string;
  mode: string;
  dropId: string;
  inventory: number;
  seatsAllocated: number;
  defenses: { rateLimit?: boolean; risk?: boolean };
  summary: Summary;
  integrity: { doubleBookedSeats: number };
  client: { endpoints: Record<string, { p95: number | null; errorRate: number; requests: number; codes: Record<string, number> }>; simValid?: boolean };
}
interface RunRow { id: string; scenario: string; seed: string; started_at: Date; config: { title?: string; scale?: number }; report: Report }

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${(x * 100).toFixed(1)}%`);
const mult = (s: Summary) => (s.humansWonNothing ? "∞" : s.advantageMultiplier === null ? "–" : `${s.advantageMultiplier.toFixed(2)}×`);
const blocked = (r: Report) =>
  Object.entries(r.client.endpoints)
    .filter(([k]) => k.endsWith("|write"))
    .reduce((n, [, v]) => n + Object.entries(v.codes).filter(([c]) => c.startsWith("429") || c.startsWith("503")).reduce((m, [, x]) => m + x, 0), 0);

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return <main><h1>Fair Drop dashboard</h1><p className="muted">Admin token required: <code>/dashboard?token=…</code></p></main>;
  }
  const p = pool();
  const { rows: runs } = await p.query<RunRow>(
    "SELECT id, scenario, seed, started_at, config, report FROM sim_runs WHERE report IS NOT NULL AND NOT archived ORDER BY started_at DESC LIMIT 200",
  );
  // Headline: latest run per scenario at the largest scale that scenario has been run at.
  const best = new Map<string, RunRow>();
  for (const r of runs) {
    const cur = best.get(r.scenario);
    if (!cur || (r.config.scale ?? 1) > (cur.config.scale ?? 1)) best.set(r.scenario, r);
  }
  const headline = [...best.values()].sort((a, b) => a.scenario.localeCompare(b.scenario));

  const { rows: live } = await p.query(
    `SELECT id, name, mode, status, inventory, opens_at, closes_at,
            (SELECT count(*)::int FROM entries e WHERE e.drop_id = drops.id) AS entries FROM drops
     WHERE status IN ('scheduled','open','closed','frozen') OR created_at > now() - interval '10 minutes'
     ORDER BY created_at DESC LIMIT 5`,
  );
  const liveIntegrity = await Promise.all(live.map((d) => checkIntegrity(p, d.id)));

  return (
    <main>
      <AutoRefresh ms={3000} />
      <h1>Fair Drop: fairness dashboard</h1>
      <p className="secondary">
        Same attack, different allocation rules. <b>Advantage multiplier</b> = P(win | bot account) ÷ P(win | human account); 1.0× means a bot account
        does no better than a person.
      </p>

      <h2>Bot share of accounts vs. bot share of seats</h2>
      <div className="card">
        <div className="legend" aria-hidden>
          <span><i style={{ background: "var(--series-1)" }} />Bot share of accounts</span>
          <span><i style={{ background: "var(--series-2)" }} />Bot share of seats won</span>
        </div>
        <div className="bars" role="img" aria-label="Bot share of accounts versus seats per scenario; exact values in the table below">
          {headline.map((r) => (
            <Pair key={r.id} label={`${r.scenario} · ${r.config.title ?? r.report.mode}`} acct={r.report.summary.botAccountShare} seat={r.report.summary.botSeatShare} />
          ))}
        </div>
        {headline.length === 0 && <p className="muted">No runs yet. Run <code>npm run sim -- --scenario S2</code>.</p>}
      </div>

      <h2>Scenario comparison</h2>
      <div className="card table-wrap">
        <RunsTable rows={headline} />
      </div>

      <h2>Across seeds (full scale)</h2>
      <div className="card table-wrap">
        <SeedStats rows={runs.filter((r) => (r.config.scale ?? 1) === 1)} />
        <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
          Each seed is an independent full run (fresh population, fresh draw secret). The range shows run-to-run noise: with 500 seats and ~2,500 bot accounts,
          bots expect ~25 seats, so ±5 seats moves the multiplier by ±0.2.
        </p>
      </div>

      <h2>Live drops</h2>
      <div className="grid">
        {live.map((d, i) => (
          <div className="card" key={d.id}>
            <div className="muted" style={{ fontSize: 12 }}>{d.mode} · {d.status}</div>
            <div style={{ fontWeight: 600 }}>{d.name}</div>
            <div className="secondary" style={{ fontSize: 13 }}>
              sold {liveIntegrity[i].activeAllocations}/{d.inventory} · entries {d.entries} · 429s {(snapshot(d.id).rate_limited_user ?? 0) + (snapshot(d.id).rate_limited_ip ?? 0)}
            </div>
            <div className={`badge ${liveIntegrity[i].ok ? "ok" : "bad"}`} style={{ fontSize: 13 }}>
              {liveIntegrity[i].ok ? "integrity OK" : `VIOLATED: oversell ${liveIntegrity[i].oversell}, double-booked ${liveIntegrity[i].doubleBookedSeats}`}
            </div>
            <div style={{ fontSize: 12 }}><a href={`/api/drops/${d.id}/audit`}>audit</a></div>
          </div>
        ))}
      </div>

      <h2>Demo controls</h2>
      <DemoControls token={token} drops={live.map((d) => ({ id: d.id, name: d.name, status: d.status }))} />

      <h2>All runs</h2>
      <div className="card table-wrap">
        <RunsTable rows={runs} showTime />
      </div>
    </main>
  );
}

function stats(xs: number[]) {
  if (!xs.length) return null;
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs) };
}

function SeedStats({ rows }: { rows: RunRow[] }) {
  const by = new Map<string, RunRow[]>();
  for (const r of rows) by.set(r.scenario, [...(by.get(r.scenario) ?? []), r]);
  const fmtR = (s: ReturnType<typeof stats>, f: (x: number) => string) => (s ? <>{f(s.mean)} <span className="muted">[{f(s.min)} – {f(s.max)}]</span></> : "–");
  return (
    <table>
      <thead>
        <tr>
          <th>Scenario</th><th>Runs</th><th className="l">Seeds</th>
          <th>Bot seat share: mean [min – max]</th><th>Advantage: mean [min – max]</th><th>Human P(win)</th><th>Max oversell</th>
        </tr>
      </thead>
      <tbody>
        {[...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sc, rs]) => {
          const inf = rs.some((r) => r.report.summary.humansWonNothing);
          return (
            <tr key={sc}>
              <td><b>{sc}</b></td>
              <td>{rs.length}</td>
              <td className="l">{[...new Set(rs.map((r) => r.seed))].sort().join(", ")}</td>
              <td>{fmtR(stats(rs.map((r) => r.report.summary.botSeatShare ?? 0)), (x) => `${(x * 100).toFixed(1)}%`)}</td>
              <td>{inf ? "∞ (humans won 0 in some runs)" : fmtR(stats(rs.map((r) => r.report.summary.advantageMultiplier).filter((x): x is number => x !== null)), (x) => `${x.toFixed(2)}×`)}</td>
              <td>{fmtR(stats(rs.map((r) => r.report.summary.pWinHuman ?? r.report.summary.humanSuccessRate ?? 0)), (x) => `${(x * 100).toFixed(2)}%`)}</td>
              <td>{Math.max(...rs.map((r) => r.report.summary.oversell))}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Pair({ label, acct, seat }: { label: string; acct: number | null; seat: number | null }) {
  return (
    <>
      <div className="label">{label}</div>
      <div className="track">
        <div className="bar acct" style={{ width: `${(acct ?? 0) * 90}%` }} title={`Bot share of accounts: ${pct(acct)}`}><span>{pct(acct)}</span></div>
        <div className="bar seat" style={{ width: `${(seat ?? 0) * 90}%` }} title={`Bot share of seats: ${pct(seat)}`}><span>{pct(seat)}</span></div>
      </div>
    </>
  );
}

function RunsTable({ rows, showTime }: { rows: RunRow[]; showTime?: boolean }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Scenario</th>
          <th className="l">Mode / defenses</th>
          <th>Scale</th>
          <th>Seats</th>
          <th>Bot acct share</th>
          <th>Bot seat share</th>
          <th>Advantage</th>
          <th>Human P(win)</th>
          <th>Human false-flag</th>
          <th>Bot flag recall</th>
          <th>Blocked (429/503)</th>
          <th>Human p95</th>
          <th>Err</th>
          <th className="l">Integrity</th>
          {showTime && <th className="l">When</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const s = r.report.summary;
          const hw = r.report.client.endpoints["human|write"];
          const dbl = r.report.integrity?.doubleBookedSeats ?? 0;
          const ok = s.integrityOk;
          return (
            <tr key={r.id}>
              <td><b>{r.scenario}</b> <span className="muted">seed {r.seed}</span></td>
              <td className="l">{r.report.mode}{r.report.defenses.rateLimit ? " · rate-limit" : ""}{r.report.defenses.risk ? " · clustering" : ""}</td>
              <td>{r.config.scale ?? 1}</td>
              <td>{r.report.seatsAllocated}/{r.report.inventory}</td>
              <td>{pct(s.botAccountShare)}</td>
              <td>{pct(s.botSeatShare)}</td>
              <td><b>{mult(s)}</b></td>
              <td>{pct(s.pWinHuman ?? s.humanSuccessRate)}</td>
              <td>{pct(s.humanFalseFlagRate)}</td>
              <td>{pct(s.botFlagRecall)}</td>
              <td>{blocked(r.report).toLocaleString()}</td>
              <td>{hw?.p95 ?? "–"} ms</td>
              <td>{pct(hw?.errorRate)}</td>
              <td className="l">
                <span className={`badge ${ok ? "ok" : "bad"}`}>
                  {ok ? "OK" : `oversell ${s.oversell}, dup ${s.duplicateUsers}, double-booked ${dbl}`}
                </span>{" "}
                {r.report.mode === "lottery" && <a href={`/api/drops/${r.report.dropId}/audit`}>audit</a>}
              </td>
              {showTime && <td className="l muted">{new Date(r.started_at).toLocaleTimeString()}</td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
