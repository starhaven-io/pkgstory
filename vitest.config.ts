import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./test/helpers/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
  test: {
    coverage: {
      include: ["src/**/*.ts", "site/src/lib/**/*.ts", "trigger/src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "lcov"],
      // Floors, not targets: leave room for honest small changes while preventing
      // the importable CLI coverage from silently regressing.
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 75,
      },
    },
  },
});
