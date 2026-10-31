import { defineConfig } from "vitest/config"

/**
 * The unit suite runs REAL sharp + REAL ffmpeg/ffprobe (vendored static binaries) against crafted
 * fixtures to prove safe-failure, plus the offline fakes (FakeStorage / in-memory repo / FakeAbuse).
 * Spawning ffmpeg per test makes individual cases slower than a pure unit test, so the timeout is
 * raised. All USE_FAKE_* default ON so nothing reaches the network.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ["test/console-guard.ts"],
    env: {
      NODE_ENV: "test",
      USE_FAKE_JOBS: "1",
      USE_FAKE_STORAGE: "1",
      USE_FAKE_ABUSE_NSFW: "1",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary"],
      // The unit-only baseline rounded down. CI also runs the integration suite, so its numbers are
      // never lower; raise these as coverage grows, never lower them.
      thresholds: { lines: 88, functions: 86, branches: 81, statements: 87 },
    },
  },
})
