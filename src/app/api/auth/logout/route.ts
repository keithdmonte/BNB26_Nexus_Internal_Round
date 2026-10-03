import { SESSION_COOKIE } from "@/lib/session";

export async function POST() {
  return new Response(null, { status: 204, headers: { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0` } });
}
