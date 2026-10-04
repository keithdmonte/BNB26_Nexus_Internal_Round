import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    env: { BEACON: "off", DRAW_KEY: "test-draw-key-0123456789", SESSION_SECRET: "test-session-secret-0123456789", DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/fairdrop_test" },
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
