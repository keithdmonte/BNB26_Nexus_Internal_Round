// Demo scenarios (docs/SIMULATION_PLAN.md). Counts are at scale 1.0; `--scale` multiplies
// populations and inventory together so ratios hold.

export type ActorType = "human" | "fast_bot" | "flooder" | "retrier" | "multi" | "rotator";

export interface BotSpec {
  type: Exclude<ActorType, "human">;
  operators: number;
  accountsEach: number;
  rps?: number; // flooder: requests/s per account
  durationS?: number; // flooder
  sharedFp?: number; // multi: probability an account reuses the operator's device fingerprint
  ipPool?: number; // multi: IPs per operator, all in one /24
  ageS?: number; // account age at drop open
  phones?: number; // real phone numbers per operator (only that many accounts can verify); default: every account has one
}

export interface Scenario {
  id: string;
  title: string;
  mode: "lottery" | "fcfs" | "fcfs_unsafe";
  inventory: number;
  windowS: number;
  defenses: { rateLimit: boolean; risk: boolean; riskPolicy?: "collapse" | "exclude"; requirePhone?: boolean };
  humans: number;
  humanIpPool: number; // campus NAT: humans share this many IPs
  humanSharedFp: number; // fraction of humans sharing a device with another human (roommates)
  bots: BotSpec[];
}

const ATTACK: BotSpec[] = [
  { type: "fast_bot", operators: 25, accountsEach: 98 },
  { type: "flooder", operators: 5, accountsEach: 10, rps: 20, durationS: 20 },
];

const base = { inventory: 500, humanIpPool: 2000, humanSharedFp: 0.005 };

export const SCENARIOS: Record<string, Scenario> = {
  S0: { ...base, id: "S0", title: "Fair Drop, normal traffic", mode: "lottery", windowS: 60,
    defenses: { rateLimit: true, risk: true }, humans: 50_000, bots: [] },
  S1: { ...base, id: "S1", title: "Naive FCFS, normal traffic", mode: "fcfs", windowS: 30,
    defenses: { rateLimit: false, risk: false }, humans: 50_000, bots: [] },
  S2: { ...base, id: "S2", title: "Naive FCFS under bot attack", mode: "fcfs", windowS: 30,
    defenses: { rateLimit: false, risk: false }, humans: 47_500, bots: ATTACK },
  S3: { ...base, id: "S3", title: "Fair Drop under the same attack", mode: "lottery", windowS: 60,
    defenses: { rateLimit: true, risk: false }, humans: 47_500, bots: ATTACK },
  S4a: { ...base, id: "S4a", title: "Multi-account operators, clustering OFF", mode: "lottery", windowS: 60,
    defenses: { rateLimit: true, risk: false }, humans: 48_000,
    bots: [{ type: "multi", operators: 2, accountsEach: 1000, sharedFp: 0.7, ipPool: 20, ageS: 3600 }] },
  S4b: { ...base, id: "S4b", title: "Multi-account operators, clustering ON", mode: "lottery", windowS: 60,
    defenses: { rateLimit: true, risk: true, riskPolicy: "collapse" }, humans: 48_000,
    bots: [{ type: "multi", operators: 2, accountsEach: 1000, sharedFp: 0.7, ipPool: 20, ageS: 3600 }] },
  S4c: { ...base, id: "S4c", title: "Evasive multi-account (distinct devices, aged), clustering ON", mode: "lottery", windowS: 60,
    defenses: { rateLimit: true, risk: true, riskPolicy: "collapse" }, humans: 48_000,
    bots: [{ type: "multi", operators: 2, accountsEach: 1000, sharedFp: 0, ipPool: 1000, ageS: 90 * 86400 }] },
  S5: { ...base, id: "S5", title: "Evasive multi-account, phone verification required", mode: "lottery", windowS: 60,
    defenses: { rateLimit: true, risk: true, riskPolicy: "collapse", requirePhone: true }, humans: 48_000,
    bots: [{ type: "multi", operators: 2, accountsEach: 1000, sharedFp: 0, ipPool: 1000, ageS: 90 * 86400, phones: 25 }] },
  S6: { ...base, id: "S6", title: "FCFS-unsafe (race condition) under attack", mode: "fcfs_unsafe", windowS: 20,
    defenses: { rateLimit: false, risk: false }, humans: 10_000, bots: [{ type: "fast_bot", operators: 10, accountsEach: 200 }] },
};
