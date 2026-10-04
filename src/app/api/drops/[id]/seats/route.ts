import { cached } from "@/lib/cache";
import { seatLayout, takenMask } from "@/lib/checkout";
import { pool } from "@/lib/db";
import { getDrop } from "@/lib/drops";
import { ApiError, json, route } from "@/lib/http";

export const dynamic = "force-dynamic";

// Venue map for seat-select drops. ?layout=1 adds the static geometry (fetch once);
// every call returns the live taken-mask, one char per seat_no ("1" = held or sold).
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const d = await getDrop(pool(), id);
  if (!d) throw new ApiError(404, "NOT_FOUND");
  if (!d.config.seatSelect || !d.config.venue) throw new ApiError(409, "WRONG_MODE", "this drop has no seat map");
  const withLayout = new URL(req.url).searchParams.get("layout") === "1";
  const [taken, seats] = await Promise.all([
    cached(`taken:${id}`, 500, () => takenMask(id)),
    withLayout ? cached(`layout:${id}`, 60_000, () => seatLayout(id)) : Promise.resolve(undefined),
  ]);
  return json({ venue: d.config.venue, taken, ...(seats ? { seats } : {}) });
});
