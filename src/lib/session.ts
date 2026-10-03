import { SignJWT, jwtVerify } from "jose";
import { ApiError } from "@/lib/http";

export const SESSION_COOKIE = "fd_sid";
const TTL_S = 24 * 3600;

function key() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("SESSION_SECRET missing or too short");
  return new TextEncoder().encode(s);
}

export interface Session {
  userId: string;
  verified: boolean;
}

/** Signed, stateless session token: survives app restarts and needs no store. */
export async function issueSession(userId: string, verified: boolean): Promise<string> {
  return new SignJWT({ v: verified })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${TTL_S}s`)
    .sign(key());
}

export function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_S}${secure}`;
}

function readToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const cookie = req.headers.get("cookie");
  const m = cookie?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

export async function getSession(req: Request): Promise<Session | null> {
  const t = readToken(req);
  if (!t) return null;
  try {
    const { payload } = await jwtVerify(t, key(), { algorithms: ["HS256"] });
    return { userId: payload.sub as string, verified: payload.v === true };
  } catch {
    return null;
  }
}

export async function requireSession(req: Request, { verified = true } = {}): Promise<Session> {
  const s = await getSession(req);
  if (!s) throw new ApiError(401, "UNAUTHENTICATED");
  if (verified && !s.verified) throw new ApiError(403, "NOT_VERIFIED");
  return s;
}
