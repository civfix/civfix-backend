/**
 * With no GLITCHTIP_DSN nothing is initialized and nothing is sent. Sentry keeps one process-wide client, so
 * these run in a file where nothing has called init.
 */

import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import * as Sentry from "@sentry/node"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runGlitchtipTest } from "../../src/db/glitchtip-test.js"
import {
  captureError,
  flushErrorReporting,
  initErrorReporting,
} from "../../src/errors/glitchtip.js"

const run = promisify(execFile)
const apiDir = fileURLToPath(new URL("../..", import.meta.url))
const SCRIPT_TIMEOUT_MS = 60_000

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("error reporting without a DSN", () => {
  it("T6: init returns false, and capture and flush do nothing", async () => {
    expect(await initErrorReporting({ environment: "test" })).toBe(false)
    expect(() => captureError(new Error("x"))).not.toThrow()
    await expect(flushErrorReporting()).resolves.toBeUndefined()
    expect(Sentry.getClient()).toBeUndefined()
  })
})

describe("glitchtip:test without a DSN", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])(
    "T8: GLITCHTIP_DSN %s: one line says nothing was sent, exit 0, no client",
    async (_label, dsn) => {
      const env: NodeJS.ProcessEnv = { ...process.env }
      delete env.GLITCHTIP_DSN
      if (dsn !== undefined) env.GLITCHTIP_DSN = dsn
      const { stdout, stderr } = await run("node_modules/.bin/tsx", ["src/db/glitchtip-test.ts"], {
        cwd: apiDir,
        env,
        timeout: SCRIPT_TIMEOUT_MS,
      })
      const lines = stdout.trim().split("\n")
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("GLITCHTIP_DSN")
      expect(lines[0]).toMatch(/nothing was sent/i)
      expect(stderr).toBe("")

      vi.stubEnv("GLITCHTIP_DSN", dsn)
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
      await runGlitchtipTest()
      expect(log).toHaveBeenCalledTimes(1)
      expect(process.exitCode ?? 0).toBe(0)
      expect(Sentry.getClient()).toBeUndefined()
    },
  )
})
