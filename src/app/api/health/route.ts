import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const serverTime = new Date().toISOString();
  try {
    const { rows } = await pool().query<{ db_time: Date }>("SELECT now() AS db_time");
    return Response.json({ ok: true, db: "ok", dbTime: rows[0].db_time.toISOString(), serverTime });
  } catch (e) {
    return Response.json({ ok: false, db: "down", error: (e as Error).message, serverTime }, { status: 503 });
  }
}
