import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/fairdrop_test" },
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
