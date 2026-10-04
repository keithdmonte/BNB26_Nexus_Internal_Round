// Venue seat maps for seat-select drops. Pure geometry: produces exactly `inventory` seats with
// section / row / price and x,y in the venue's own coordinate space. seat_no order is front-first,
// so lower seat numbers are the better (pricier) seats.

export type VenueKind = "stadium" | "arena" | "theatre";

export interface VenueTier {
  name: string;
  price: number; // INR
}

export interface VenueMeta {
  kind: VenueKind;
  width: number;
  height: number;
  stage: { label: string; shape: "rect" | "ellipse"; x: number; y: number; w: number; h: number };
  tiers: VenueTier[];
}

export interface VenueSeat {
  section: string;
  row: string;
  label: string;
  price: number;
  x: number;
  y: number;
}

export const MAX_SEATS_PER_ORDER = 6;

/** "Title | Venue | Category" demo names: Sports gets a stadium, Music an arena, anything else a theatre. */
export function venueKindFor(name: string): VenueKind {
  const cat = name.split("|")[2]?.trim().toLowerCase() ?? "";
  if (cat === "sports") return "stadium";
  if (cat === "music") return "arena";
  return "theatre";
}

function rowName(i: number): string {
  let s = "";
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
}

/** Keeps k of n items, spread evenly, so a trimmed last row has no lopsided gap. */
function spread<T>(items: T[], k: number): T[] {
  if (k >= items.length) return items;
  const out: T[] = [];
  for (let j = 0; j < k; j++) out.push(items[Math.floor(((j + 0.5) * items.length) / k)]);
  return out;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Fan of curved rows facing a stage, split into three blocks by two aisles. */
function fan(inventory: number, kind: "arena" | "theatre"): { seats: VenueSeat[]; meta: Omit<VenueMeta, "width" | "height"> } {
  const tiers: VenueTier[] =
    kind === "arena"
      ? [{ name: "Fan Pit", price: 4999 }, { name: "Gold", price: 2999 }, { name: "Silver", price: 1499 }, { name: "General", price: 799 }]
      : [{ name: "Premium", price: 1999 }, { name: "Gold", price: 1199 }, { name: "Silver", price: 699 }];
  const tierOf = (row: number) => (kind === "arena" ? (row < 3 ? 0 : row < 8 ? 1 : row < 14 ? 2 : 3) : row < 3 ? 0 : row < 8 ? 1 : 2);
  const half = kind === "arena" ? (70 * Math.PI) / 180 : (52 * Math.PI) / 180;
  const aisle = (4 * Math.PI) / 180; // half-width of each aisle gap
  const cx = 0, cy = 0, pitch = 22, r0 = 130;
  const seats: VenueSeat[] = [];
  for (let row = 0; seats.length < inventory; row++) {
    const r = r0 + row * pitch;
    const n = Math.floor((2 * half * r) / pitch);
    const rowSeats: { a: number; block: string }[] = [];
    for (let j = 0; j < n; j++) {
      const a = -half + ((j + 0.5) * 2 * half) / n;
      const third = half / 3;
      if (Math.abs(Math.abs(a) - third) < aisle) continue;
      rowSeats.push({ a, block: a < -third ? "Left" : a > third ? "Right" : "Centre" });
    }
    const keep = spread(rowSeats, inventory - seats.length);
    const tier = tiers[tierOf(row)];
    keep.forEach((s, j) =>
      seats.push({
        section: `${tier.name} · ${s.block}`,
        row: rowName(row),
        label: `${rowName(row)}${j + 1}`,
        price: tier.price,
        x: r1(cx + r * Math.sin(s.a)),
        y: r1(cy + r * Math.cos(s.a)),
      }),
    );
  }
  const stageW = kind === "arena" ? 200 : 160;
  return {
    seats,
    meta: { kind, stage: { label: "STAGE", shape: "rect", x: -stageW / 2, y: 20, w: stageW, h: 56 }, tiers: tiers.filter((_, i) => seats.some((s) => s.price === tiers[i].price)) },
  };
}

/** Elliptical rings of stands around a pitch, split into four stands. */
function stadium(inventory: number): { seats: VenueSeat[]; meta: Omit<VenueMeta, "width" | "height"> } {
  const tiers: VenueTier[] = [
    { name: "Pavilion", price: 3500 },
    { name: "Lower", price: 1800 },
    { name: "Upper", price: 900 },
  ];
  const stands = ["North Stand", "East Stand", "South Stand", "West Stand"];
  const pitch = 20, rx0 = 240, ry0 = 170;
  const gap = (5 * Math.PI) / 180;
  const seats: VenueSeat[] = [];
  for (let ring = 0; seats.length < inventory; ring++) {
    const rx = rx0 + ring * pitch, ry = ry0 + ring * pitch;
    const perim = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
    const n = Math.floor(perim / pitch);
    const ringSeats: { a: number; stand: number }[] = [];
    for (let j = 0; j < n; j++) {
      // a = 0 points up (north); stands centred on N/E/S/W with gaps on the diagonals.
      const a = (j / n) * 2 * Math.PI;
      const q = (a + Math.PI / 4) % (Math.PI / 2);
      if (q < gap || q > Math.PI / 2 - gap) continue;
      ringSeats.push({ a, stand: Math.floor(((a + Math.PI / 4) % (2 * Math.PI)) / (Math.PI / 2)) });
    }
    const keep = spread(ringSeats, inventory - seats.length);
    const counters = [0, 0, 0, 0];
    for (const s of keep) {
      // West is the pavilion end: its front rings are the premium tier.
      const tier = s.stand === 3 && ring < 4 ? tiers[0] : ring < 4 ? tiers[1] : tiers[2];
      const no = ++counters[s.stand];
      seats.push({
        section: `${stands[s.stand]} · ${tier.name}`,
        row: rowName(ring),
        label: `${rowName(ring)}${no}`,
        price: tier.price,
        x: r1(rx * Math.sin(s.a)),
        y: r1(-ry * Math.cos(s.a)),
      });
    }
  }
  return {
    seats,
    meta: { kind: "stadium", stage: { label: "PITCH", shape: "ellipse", x: -rx0 + 40, y: -ry0 + 40, w: 2 * (rx0 - 40), h: 2 * (ry0 - 40) }, tiers },
  };
}

/** Builds the map and shifts it so every coordinate is positive inside width x height. */
export function buildVenue(kind: VenueKind, inventory: number): { seats: VenueSeat[]; meta: VenueMeta } {
  const { seats, meta } = kind === "stadium" ? stadium(inventory) : fan(inventory, kind);
  const pad = 30;
  const xs = [...seats.map((s) => s.x), meta.stage.x, meta.stage.x + meta.stage.w];
  const ys = [...seats.map((s) => s.y), meta.stage.y, meta.stage.y + meta.stage.h];
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  const width = Math.ceil(Math.max(...xs) + pad - minX), height = Math.ceil(Math.max(...ys) + pad - minY);
  return {
    seats: seats.map((s) => ({ ...s, x: r1(s.x - minX), y: r1(s.y - minY) })),
    meta: { ...meta, width, height, stage: { ...meta.stage, x: r1(meta.stage.x - minX), y: r1(meta.stage.y - minY) } },
  };
}
