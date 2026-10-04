import { timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

// Admin auth for the dashboard: a one-time login exchanges ADMIN_TOKEN for an HttpOnly cookie,
// so the token never appears in URLs, browser history or access logs. Scripts may still send X-Admin-Token.
export const ADMIN_COOKIE = "fd_admin";
const TTL_S = 8 * 3600;

function key() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("SESSION_SECRET missing or too short");
  // Distinct key from user sessions, so a user session token can never be replayed as an admin cookie.
  return new TextEncoder().encode(`${s}:admin`);
}

export function adminTokenMatches(candidate: string | null | undefined): boolean {
  const real = process.env.ADMIN_TOKEN;
  if (!real || !candidate) return false;
  const a = Buffer.from(candidate), b = Buffer.from(real);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function issueAdminCookie(): Promise<string> {
  const jwt = await new SignJWT({ adm: true }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(`${TTL_S}s`).sign(key());
  const secure = process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "true" ? "; Secure" : "";
  return `${ADMIN_COOKIE}=${jwt}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL_S}${secure}`;
}

export async function adminCookieValid(value: string | undefined | null): Promise<boolean> {
  if (!value) return false;
  try {
    const { payload } = await jwtVerify(value, key(), { algorithms: ["HS256"] });
    return payload.adm === true;
  } catch {
    return false;
  }
}

export function readCookie(req: Request, name: string): string | null {
  const m = req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}
