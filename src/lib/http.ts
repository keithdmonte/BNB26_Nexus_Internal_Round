import { pool } from "@/lib/db";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public retryAfterMs?: number,
  ) {
    super(message ?? code);
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(
    { ...(body as object), serverTime: new Date().toISOString() },
    { status, headers },
  );
}

export function errorResponse(e: unknown): Response {
  if (e instanceof ApiError) {
    const headers: Record<string, string> = {};
    if (e.retryAfterMs !== undefined) headers["Retry-After"] = String(Math.max(1, Math.ceil(e.retryAfterMs / 1000)));
    return json({ error: { code: e.code, message: e.message, retryAfterMs: e.retryAfterMs } }, e.status, headers);
  }
  console.error(e);
  return json({ error: { code: "INTERNAL", message: "internal error" } }, 500);
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/** Call after rate limiting, so abusive clients are rejected before they count against capacity. */
export function shedIfBusy() {
  if (pool().waitingCount > Number(process.env.MAX_DB_QUEUE ?? 500)) {
    throw new ApiError(503, "OVERLOADED", "server busy, retry shortly", 1000);
  }
}

/** Wraps a route handler: maps ApiError to JSON responses. */
export function route<C>(fn: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function simTrusted(req: Request): boolean {
  return process.env.SIM_MODE === "true" && !!process.env.SIM_SECRET && req.headers.get("x-sim-secret") === process.env.SIM_SECRET;
}

/** Client IP. The sim-only header is honoured only in SIM_MODE with the shared secret (see ABUSE_DEFENSE). */
export function clientIp(req: Request): string {
  if (simTrusted(req)) {
    const sim = req.headers.get("x-sim-client-ip");
    if (sim) return sim;
  }
  const xff = req.headers.get("x-forwarded-for");
  return xff ? xff.split(",")[0].trim() : "127.0.0.1";
}

export function requireWriteHeaders(req: Request): string {
  if (req.headers.get("x-requested-with") !== "fairdrop") {
    throw new ApiError(403, "FORBIDDEN", "missing X-Requested-With");
  }
  const key = req.headers.get("idempotency-key");
  if (!key || key.length > 100) throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED");
  return key;
}

export function requireAdmin(req: Request) {
  const token = req.headers.get("x-admin-token") ?? new URL(req.url).searchParams.get("token");
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) throw new ApiError(403, "FORBIDDEN");
}

export function requireSim(req: Request) {
  if (!simTrusted(req)) throw new ApiError(403, "FORBIDDEN", "sim endpoints disabled");
}

export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const err = e as { code?: string; constraint?: string };
  return err?.code === "23505" && (!constraint || err.constraint === constraint);
}
