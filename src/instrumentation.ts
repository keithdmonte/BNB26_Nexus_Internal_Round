export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.SCHEDULER !== "off") {
    const { startScheduler } = await import("@/lib/scheduler");
    startScheduler();
  }
}
