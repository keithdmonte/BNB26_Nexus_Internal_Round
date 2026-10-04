import { adminTokenMatches, issueAdminCookie } from "@/lib/admin";
import { ApiError, json, route } from "@/lib/http";
import { take } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

// One-time exchange: ADMIN_TOKEN (in the POST body, never the URL) for an HttpOnly admin cookie.
export const POST = route(async (req) => {
  if (take("admin-login", 1, 10)) throw new ApiError(429, "RATE_LIMITED", "too many login attempts", 1000);
  const { token } = (await req.json().catch(() => ({}))) as { token?: string };
  if (!adminTokenMatches(token)) throw new ApiError(403, "FORBIDDEN", "wrong admin token");
  return json({ ok: true }, 200, { "Set-Cookie": await issueAdminCookie() });
});
