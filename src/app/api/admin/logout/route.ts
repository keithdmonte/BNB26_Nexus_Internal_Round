import { ADMIN_COOKIE } from "@/lib/admin";

export async function POST() {
  return new Response(null, { status: 204, headers: { "Set-Cookie": `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` } });
}
