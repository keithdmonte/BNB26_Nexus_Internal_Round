import { pool } from "@/lib/db";
import { ApiError, json, route } from "@/lib/http";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const s = await requireSession(req, { verified: false });
  const { rows } = await pool().query("SELECT id, email, verified_at FROM users WHERE id = $1", [s.userId]);
  if (!rows[0]) throw new ApiError(401, "UNAUTHENTICATED");
  return json({ user: { id: rows[0].id, email: rows[0].email, verified: !!rows[0].verified_at } });
});
