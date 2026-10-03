import { ApiError, json, route } from "@/lib/http";
import { audit } from "@/lib/lottery";

export const dynamic = "force-dynamic";

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, "NOT_FOUND");
  const a = await audit(id);
  if (!a) throw new ApiError(404, "NOT_FOUND");
  return json(a);
});
