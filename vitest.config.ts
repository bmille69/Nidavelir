import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    pool: "forks",
    // Toute la suite en parallèle sous Windows : un test qui fait plusieurs commits Git dépasse parfois 5 s.
    testTimeout: 30_000,
  },
});
