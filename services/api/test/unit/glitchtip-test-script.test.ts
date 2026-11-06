/**
 * The glitchtip:test script sends one tagged event through the API's own init and scrubbing, carrying a
 * fake email, IP address and cookie where the SDK would pick them up, and none of them leaves.
 */

import { afterEach, expect, it, vi } from "vitest"
import { runGlitchtipTest } from "../../src/db/glitchtip-test.js"
import {
  FAKE_GLITCHTIP_DSN,
  recordingTransport,
  sentryClientOptions,
} from "../helpers/sentry-transport.js"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it("T9: sends one event tagged glitchtip-test with the fake personal data stripped", async () => {
  vi.stubEnv("GLITCHTIP_DSN", FAKE_GLITCHTIP_DSN)
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  const recorder = recordingTransport()

  await runGlitchtipTest(recorder.transport)

  const events = recorder.items("event") as Record<string, unknown>[]
  expect(events).toHaveLength(1)
  const event = events[0]!
  expect((event.tags as Record<string, unknown> | undefined)?.["glitchtip-test"]).toBe("true")
  expect(event).not.toHaveProperty("user")
  const serialized = recorder.serialized()
  for (const fake of ["glitchtip-test@example.com", "198.51.100.23", "glitchtip-test-cookie"]) {
    expect(serialized).not.toContain(fake)
  }
  const options = sentryClientOptions() ?? {}
  expect(options.sendDefaultPii).toBe(false)
  expect(options).not.toHaveProperty("dataCollection")
})

it("T9: fails instead of reporting a send when error reporting does not start", async () => {
  vi.stubEnv("GLITCHTIP_DSN", FAKE_GLITCHTIP_DSN)
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.resetModules()
  vi.doMock("../../src/errors/glitchtip.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/errors/glitchtip.js")>()),
    initErrorReporting: () => Promise.resolve(false),
  }))
  try {
    const { runGlitchtipTest: run } = await import("../../src/db/glitchtip-test.js")
    await expect(run()).rejects.toThrow("error reporting did not start, so nothing was sent")
    expect(log).not.toHaveBeenCalled()
  } finally {
    vi.doUnmock("../../src/errors/glitchtip.js")
    vi.resetModules()
  }
})
