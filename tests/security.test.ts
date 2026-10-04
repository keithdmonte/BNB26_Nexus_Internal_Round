import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/lib/db";
import { clientIp, inetOrNull, requireAdmin } from "@/lib/http";
import { ADMIN_COOKIE, issueAdminCookie } from "@/lib/admin";
import { issueSession } from "@/lib/session";
import { resetBuckets } from "@/lib/ratelimit";
import { POST as devLogin } from "@/app/api/auth/dev-login/route";
import { POST as adminLogin } from "@/app/api/admin/login/route";
import { migrate } from "../scripts/migrate";
import { resetDb } from "./helpers";

const ENV = { ...process.env };
beforeAll(async () => {
  await migrate(process.env.DATABASE_URL!, () => {});
});
beforeEach(async () => {
  await resetDb();
  resetBuckets();
  Object.assign(process.env, { ADMIN_TOKEN: "admin-secret-token", DEV_LOGIN: "true", SIM_MODE: "false", SIM_SECRET: "sim-s3cret" });
  delete process.env.TRUST_PROXY;
});
afterEach(() => {
  for (const k of ["ADMIN_TOKEN", "DEV_LOGIN", "SIM_MODE", "SIM_SECRET", "TRUST_PROXY"]) {
    if (ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ENV[k];
  }
});
afterAll(() => pool().end());

const req = (headers: Record<string, string>, url = "http://x/api") => new Request(url, { headers });
const cookieOf = (r: Response) => r.headers.get("set-cookie")!.split(";")[0];

describe("clientIp", () => {
  it("ignores X-Forwarded-For unless TRUST_PROXY=true; uses the server-stamped socket address", () => {
    const r = req({ "x-forwarded-for": "6.6.6.6", "x-fd-socket-ip": "::ffff:10.1.2.3" });
    expect(clientIp(r)).toBe("10.1.2.3");
    process.env.TRUST_PROXY = "true";
    expect(clientIp(r)).toBe("6.6.6.6");
  });
  it("returns 'unknown' without a socket header (and inetOrNull maps it to NULL)", () => {
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6" }))).toBe("unknown");
    expect(inetOrNull("unknown")).toBeNull();
    expect(inetOrNull("10.0.0.1")).toBe("10.0.0.1");
  });
  it("honours the sim IP header only in SIM_MODE with the right secret", () => {
    const h = { "x-sim-client-ip": "203.0.113.9", "x-sim-secret": "sim-s3cret", "x-fd-socket-ip": "10.0.0.1" };
    expect(clientIp(req(h))).toBe("10.0.0.1");
    process.env.SIM_MODE = "true";
    expect(clientIp(req(h))).toBe("203.0.113.9");
    expect(clientIp(req({ ...h, "x-sim-secret": "wrong" }))).toBe("10.0.0.1");
  });
});

describe("dev-login cannot take over an existing account", () => {
  const login = (email: string, cookie?: string) =>
    devLogin(new Request("http://x/api/auth/dev-login", { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ email }) }), {} as never);

  it("creates a new account, then refuses the same email from a different session", async () => {
    const first = await login("victim@test.dev");
    expect(first.status).toBe(200);
    const id = (await first.json()).user.id;
    const attacker = await login("victim@test.dev");
    expect(attacker.status).toBe(409);
    expect((await attacker.json()).error.code).toBe("EMAIL_TAKEN");
    expect(attacker.headers.get("set-cookie")).toBeNull();
    const other = await issueSession("00000000-0000-4000-8000-000000000000", true);
    expect((await login("victim@test.dev", `fd_sid=${other}`)).status).toBe(409);
    const again = await login("VICTIM@test.dev", cookieOf(first));
    expect(again.status).toBe(200);
    expect((await again.json()).user.id).toBe(id);
  });

  it("is disabled unless DEV_LOGIN=true", async () => {
    process.env.DEV_LOGIN = "false";
    expect((await login("a@test.dev")).status).toBe(404);
  });
});

describe("admin auth", () => {
  it("accepts the X-Admin-Token header and a valid admin cookie", async () => {
    await expect(requireAdmin(req({ "x-admin-token": "admin-secret-token" }))).resolves.toBeUndefined();
    const c = (await issueAdminCookie()).split(";")[0];
    await expect(requireAdmin(req({ cookie: c }))).resolves.toBeUndefined();
  });
  it("rejects the token in the URL, a forged cookie, and a user session token used as the admin cookie", async () => {
    await expect(requireAdmin(req({}, "http://x/api?token=admin-secret-token"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(requireAdmin(req({ cookie: `${ADMIN_COOKIE}=not.a.jwt` }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const userJwt = await issueSession("00000000-0000-4000-8000-000000000000", true);
    await expect(requireAdmin(req({ cookie: `${ADMIN_COOKIE}=${userJwt}` }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(requireAdmin(req({ "x-admin-token": "wrong" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("one-time login exchanges the token for an HttpOnly SameSite=Strict cookie", async () => {
    const post = (token: string) => adminLogin(new Request("http://x/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }), {} as never);
    expect((await post("wrong")).status).toBe(403);
    const ok = await post("admin-secret-token");
    expect(ok.status).toBe(200);
    const sc = ok.headers.get("set-cookie")!;
    expect(sc).toMatch(new RegExp(`^${ADMIN_COOKIE}=`));
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/SameSite=Strict/);
    await expect(requireAdmin(req({ cookie: sc.split(";")[0] }))).resolves.toBeUndefined();
  });
});
