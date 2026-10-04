import { pool } from "@/lib/db";
import { json, requireAdmin, route } from "@/lib/http";
import { checkIntegrity } from "@/lib/integrity";

export const dynamic = "force-dynamic";

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  await requireAdmin(req);
  const { id } = await params;
  return json(await checkIntegrity(pool(), id));
});
