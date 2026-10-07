import type { FastifyInstance } from "fastify"
import { describe, expect, it, vi } from "vitest"

const stubRegistration = vi.hoisted(
  () => (exportName: string) => async (importOriginal: () => Promise<Record<string, unknown>>) => ({
    ...(await importOriginal()),
    [exportName]: vi.fn(() => Promise.resolve()),
  }),
)

vi.mock("../../src/services/admin/outreach-jobs.js", stubRegistration("registerOutreachJobs"))
vi.mock("../../src/services/admin/inbound-jobs.js", stubRegistration("registerInboundJobs"))
vi.mock("../../src/services/admin/discovery-jobs.js", stubRegistration("registerDiscoveryJobs"))
vi.mock("../../src/services/admin/autoforward-jobs.js", stubRegistration("registerAutoForwardJobs"))
vi.mock("../../src/services/data-export-jobs.js", stubRegistration("registerDataExportJobs"))
vi.mock("../../src/services/chat-fanout-jobs.js", stubRegistration("registerChatRoomFanoutJob"))
vi.mock("../../src/services/cleanup-jobs.js", stubRegistration("registerCleanupCancelFanoutJob"))
vi.mock("../../src/services/guest-jobs.js", stubRegistration("registerGuestJobs"))
vi.mock(
  "../../src/services/host/registration-jobs.js",
  stubRegistration("registerRegistrationJobs"),
)
vi.mock("../../src/services/host/comms-jobs.js", stubRegistration("registerCommsJobs"))

const { startBackgroundJobs } = await import("../../src/server.js")
const { registerOutreachJobs } = await import("../../src/services/admin/outreach-jobs.js")
const { loadEnv } = await import("../../src/env.js")

function fakeApp() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const container = {
    jobs: { start: vi.fn(() => Promise.resolve()), enqueue: vi.fn(() => Promise.resolve()) },
  }
  return { app: { container, log } as unknown as FastifyInstance, container, log }
}

describe("startBackgroundJobs", () => {
  it("hands the app logger to the outreach job registration so a failed claim release is logged", async () => {
    const { app, container, log } = fakeApp()
    const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: "postgres://u:p@localhost/db" })

    await startBackgroundJobs(app, env)

    expect(registerOutreachJobs).toHaveBeenCalledWith(container, log)
  })
})
