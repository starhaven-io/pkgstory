import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "lcov"],
      // Floors, not targets: set under the current numbers so honest small
      // changes pass. cli.ts runs as a subprocess, so v8 scores it 0% and the
      // reachable ceiling is lower than it looks.
      thresholds: {
        lines: 75,
        statements: 75,
        functions: 75,
        branches: 60,
      },
    },
  },
});
