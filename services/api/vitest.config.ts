import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // ONE PostGIS container for the whole run. It applies the migrations + seed once into a template
    // database and hands the workers a connection URI; withPg() then clones that template per test
    // file. Starts nothing when no pg-using file is selected, and
    // reports a Docker-absent machine to the workers so describe.skipIf(!pg) still skips instead of
    // failing. See test/global-setup-pg.ts.
    globalSetup: ["test/global-setup-pg.ts"],
    setupFiles: ["test/console-guard.ts"],
    // Route tests boot a full offline Fastify app per suite; under parallel load that can exceed the
    // 5s default, so the timeout is raised to keep the suite deterministic in CI.
    testTimeout: 20000,
    hookTimeout: 20000,
    // Unit tests must run with no external infra. Force all fakes on and a test NODE_ENV so the
    // env loader supplies safe defaults regardless of the developer's shell environment.
    env: {
      NODE_ENV: "test",
      USE_FAKE_STORAGE: "1",
      USE_FAKE_MAILER: "1",
      USE_FAKE_PUSH: "1",
      USE_FAKE_ABUSE_NSFW: "1",
      USE_FAKE_CHAT: "1",
      USE_FAKE_JOBS: "1",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary"],
      // The unit-only baseline rounded down. CI also runs the integration suite, so its numbers come
      // out higher; raise these as coverage grows, never lower them.
      thresholds: { lines: 86, functions: 84, branches: 74, statements: 84 },
    },
  },
})
