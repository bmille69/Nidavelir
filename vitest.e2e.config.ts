import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/e2e/**/*.e2e.ts"],
    pool: "forks",
    testTimeout: 25_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
