import { defineConfig } from "vitest/config"

/**
 * The runner cases spawn real node processes and the fixture-portal cases drive a real Chromium through
 * the kit (PLAYWRIGHT_BROWSERS_PATH, installed by CI), so their timeout is raised. Every filer process is
 * spawned through a copy of bin/filer-shell with the setpriv step removed: the tests do not run as root,
 * and the real uid drop is proven by dist/preflight.js inside the image.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    env: { NODE_ENV: "test" },
  },
})
