// Fairness reporting. The ONLY module allowed to read sim_labels (ground truth), and it is never
// imported by defense code. See docs/METRICS.md.
import { pool } from "@/lib/db";
import { checkIntegrity } from "@/lib/integrity";
import { snapshot } from "@/lib/counters";

interface Group {
  accounts: number;
  entered: number;
  flagged: number;
  winners: number;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

/** P(win) for humans bucketed by arrival time (10 equal-size groups, earliest first). */
export function arrivalDeciles(arrivals: Record<string, number>, winners: Set<string>) {
  const xs = Object.entries(arrivals).sort((a, b) => a[1] - b[1]);
  const out = [];
  for (let d = 0; d < 10; d++) {
    const slice = xs.slice(Math.floor((d * xs.length) / 10), Math.floor(((d + 1) * xs.length) / 10));
    const won = slice.filter(([u]) => winners.has(u)).length;
    out.push({ decile: d + 1, fromMs: slice[0]?.[1] ?? null, toMs: slice.at(-1)?.[1] ?? null, n: slice.length, winners: won, pWin: slice.length ? won / slice.length : null });
  }
  return out;
}

export async function fairnessReport(runId: string, arrivals?: Record<string, number>, arrivalsAll?: Record<string, number>) {
  const p = pool();
  const { rows: run } = await p.query(
    "SELECT r.id, r.scenario, r.seed, r.config, r.drop_id, d.mode, d.inventory, d.status FROM sim_runs r JOIN drops d ON d.id = r.drop_id WHERE r.id = $1",
    [runId],
  );
  if (!run[0]) return null;
  const { drop_id: dropId, mode, inventory } = run[0];
  const allocTable = mode === "fcfs_unsafe" ? "allocations_unsafe" : "allocations";
  const { rows } = await p.query(
    `SELECT l.user_id, l.actor_type, l.operator_id,
            e.status AS entry_status,
            (SELECT count(*)::int FROM ${allocTable} a WHERE a.drop_id = $2 AND a.user_id = l.user_id
               AND a.status IN ('offered','confirmed')) AS seats
     FROM sim_labels l
     LEFT JOIN entries e ON e.drop_id = $2 AND e.user_id = l.user_id
     WHERE l.run_id = $1`,
    [runId, dropId],
  );

  const byType: Record<string, Group & { seats: number }> = {};
  const ops = new Map<string, { type: string; accounts: number; seats: number }>();
  const human: Group = { accounts: 0, entered: 0, flagged: 0, winners: 0 };
  const bot: Group = { accounts: 0, entered: 0, flagged: 0, winners: 0 };
  let seatsTotal = 0, humanSeats = 0, botSeats = 0;
  for (const r of rows) {
    const t = (byType[r.actor_type] ??= { accounts: 0, entered: 0, flagged: 0, winners: 0, seats: 0 });
    const g = r.actor_type === "human" ? human : bot;
    const flagged = r.entry_status && r.entry_status !== "active" ? 1 : 0;
    const won = r.seats > 0 ? 1 : 0;
    for (const x of [t, g]) {
      x.accounts++;
      x.entered += r.entry_status ? 1 : 0;
      x.flagged += flagged;
      x.winners += won;
    }
    t.seats += r.seats;
    seatsTotal += r.seats;
    if (r.actor_type === "human") humanSeats += r.seats;
    else botSeats += r.seats;
    if (r.operator_id) {
      const o = ops.get(r.operator_id) ?? { type: r.actor_type, accounts: 0, seats: 0 };
      o.accounts++;
      o.seats += r.seats;
      ops.set(r.operator_id, o);
    }
  }
  const totalAccounts = human.accounts + bot.accounts;
  const winnerIds = new Set(rows.filter((r) => r.seats > 0).map((r) => r.user_id as string));
  const pHuman = ratio(human.winners, human.accounts);
  const pBot = ratio(bot.winners, bot.accounts);
  const integrity = await checkIntegrity(p, dropId);
  const operators = [...ops.entries()]
    .map(([id, o]) => ({ operatorId: id, ...o, fairShare: totalAccounts ? (o.accounts * seatsTotal) / totalAccounts : 0 }))
    .sort((a, b) => b.seats - a.seats)
    .slice(0, 10);

  return {
    runId,
    scenario: run[0].scenario,
    seed: Number(run[0].seed),
    mode,
    defenses: run[0].config?.defenses ?? {},
    dropId,
    dropStatus: run[0].status,
    inventory,
    seatsAllocated: seatsTotal,
    summary: {
      botAccountShare: ratio(bot.accounts, totalAccounts),
      botSeatShare: ratio(botSeats, seatsTotal),
      humanSeatShare: ratio(humanSeats, seatsTotal),
      pWinHuman: pHuman,
      pWinBot: pBot,
      advantageMultiplier: pHuman && pBot !== null ? pBot / pHuman : null,
      humansWonNothing: human.winners === 0 && bot.winners > 0,
      humanFalseFlagRate: ratio(human.flagged, human.entered),
      botFlagRecall: ratio(bot.flagged, bot.entered),
      oversell: integrity.oversell,
      duplicateUsers: integrity.duplicateUsers,
      integrityOk: integrity.ok,
    },
    byType,
    operators,
    integrity,
    arrivalDeciles: arrivals ? arrivalDeciles(arrivals, winnerIds) : null,
    arrivalDecilesAll: arrivalsAll ? arrivalDeciles(arrivalsAll, winnerIds) : null,
    serverCounters: snapshot(dropId),
  };
}
