import { afterEach, describe, expect, it, vi } from "vitest"

const bossErrorHandlers: ((err: Error) => void)[] = []

vi.mock("pg-boss", () => ({
  default: class {
    on(event: string, handler: (err: Error) => void): void {
      if (event === "error") bossErrorHandlers.push(handler)
    }
    start(): Promise<void> {
      return Promise.resolve()
    }
    createQueue(): Promise<void> {
      return Promise.resolve()
    }
    updateQueue(): Promise<void> {
      return Promise.resolve()
    }
  },
}))

vi.mock("nodemailer", () => ({
  createTransport: () => ({
    verify: () => Promise.reject(new Error("535 authentication failed")),
    sendMail: () => Promise.resolve({ messageId: "<m@civfix.org>" }),
  }),
}))

const { PgBossJobs } = await import("../../src/adapters/jobs.pgboss.js")
const { OciMailer } = await import("../../src/adapters/mailer.oci.js")
const { buildContainer } = await import("../../src/di.js")
const { loadEnv } = await import("../../src/env.js")

function recordingLogger() {
  return { warn: vi.fn(), error: vi.fn() }
}

afterEach(() => {
  bossErrorHandlers.length = 0
  vi.restoreAllMocks()
})

describe("adapter logging goes through the injected logger", () => {
  it("routes pg-boss errors to the injected logger instead of console", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const logger = recordingLogger()
    const jobs = new PgBossJobs({ connectionString: "postgres://u:p@localhost/db", logger })
    await jobs.start()

    const failure = new Error("connection terminated")
    bossErrorHandlers[0]!(failure)

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: failure }),
      expect.any(String),
    )
    expect(consoleError).not.toHaveBeenCalled()
  })

  it("routes a failed SMTP verify to the injected logger instead of console", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const logger = recordingLogger()
    const mailer = new OciMailer({
      host: "smtp.example",
      port: 587,
      user: "u",
      pass: "p",
      fromNoReply: "no-reply@civfix.org",
      fromOutreach: "outreach@civfix.org",
      logger,
    })

    await mailer.sendOutbound({
      from: "no-reply@civfix.org",
      to: "someone@example.com",
      subject: "hi",
      text: "hello",
    })
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled())
    expect(consoleWarn).not.toHaveBeenCalled()
  })

  it("wires the server logger into abuse checks and the push sender built by the container", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const container = buildContainer(
      loadEnv({
        NODE_ENV: "test",
        USE_FAKE_ABUSE_NSFW: "0",
        USE_FAKE_PUSH: "0",
        DATABASE_URL: "postgres://u:p@localhost:5432/civfix",
      }),
    )
    const pushSender = container.pushSender as unknown as {
      logger: { warn(obj: unknown, msg?: string): void }
    }
    const serverLogger = recordingLogger()
    container.getNotificationService(serverLogger)

    await container.abuseChecks.nsfwScore(new Uint8Array([1]))
    pushSender.logger.warn({ probe: true }, "push probe")

    expect(serverLogger.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("NSFW model"),
    )
    expect(serverLogger.warn).toHaveBeenCalledWith({ probe: true }, "push probe")
    expect(consoleWarn).not.toHaveBeenCalled()
  })
})
