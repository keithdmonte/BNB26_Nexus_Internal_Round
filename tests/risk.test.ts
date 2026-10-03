import { describe, expect, it } from "vitest";
import { scoreEntries } from "@/lib/risk";

const opens = new Date("2026-10-04T00:00:00Z");
const old = new Date("2026-01-01T00:00:00Z");
const fresh = new Date("2026-10-03T23:00:00Z");
const e = (id: string, fp: string | null, ip: string, created: Date) => ({ entryId: id, publicId: `p${id}`, deviceFp: fp, signupIp: ip, accountCreatedAt: created });

describe("risk clustering", () => {
  it("collapses accounts sharing a device to one entry", () => {
    const out = scoreEntries([e("1", "fpA", "1.1.1.1", old), e("2", "fpA", "2.2.2.2", old), e("3", "fpA", "3.3.3.3", old), e("4", "fpB", "4.4.4.4", old)], opens);
    expect(out.filter((x) => x.status === "active").map((x) => x.entryId).sort()).toEqual(["1", "4"]);
  });

  it("does not link old accounts behind the same NAT (campus wifi)", () => {
    const out = scoreEntries(Array.from({ length: 50 }, (_, i) => e(String(i), `fp${i}`, "10.0.0.1", old)), opens);
    expect(out.every((x) => x.status === "active")).toBe(true);
  });

  it("links 3+ fresh accounts from the same /24", () => {
    const out = scoreEntries([e("1", null, "5.5.5.1", fresh), e("2", null, "5.5.5.2", fresh), e("3", null, "5.5.5.3", fresh), e("4", null, "6.6.6.1", fresh)], opens);
    expect(out.filter((x) => x.status === "collapsed")).toHaveLength(2);
    expect(out.find((x) => x.entryId === "4")!.status).toBe("active");
  });

  it("exclude policy drops the whole cluster", () => {
    const out = scoreEntries([e("1", "fpA", "1.1.1.1", old), e("2", "fpA", "2.2.2.2", old)], opens, "exclude");
    expect(out.every((x) => x.status === "excluded")).toBe(true);
  });
});
