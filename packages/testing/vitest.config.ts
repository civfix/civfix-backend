import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/console-guard.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary"],
      // The measured baseline rounded down; raise these as coverage grows, never lower them.
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
})
