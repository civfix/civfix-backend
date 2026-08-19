import { describe, it, expect, vi } from "vitest"
import { hashForLog, type PushLogger } from "../../src/adapters/push-sender.js"
import { makeFcmDispatcher } from "../../src/adapters/push-fcm.js"

const sendEachForMulticast = vi.fn()

vi.mock("firebase-admin/app", () => ({
  getApps: () => [],
  initializeApp: () => ({ name: "civfix-push" }),
  cert: () => ({}),
  deleteApp: async () => {},
}))

vi.mock("firebase-admin/messaging", () => ({
  getMessaging: () => ({ sendEachForMulticast }),
}))

function recordingLogger(): { logger: PushLogger; warns: unknown[]; errors: unknown[] } {
  const warns: unknown[] = []
  const errors: unknown[] = []
  return {
    logger: { warn: (obj) => warns.push(obj), error: (obj) => errors.push(obj) },
    warns,
    errors,
  }
}

describe("hashForLog (F021)", () => {
  it("is deterministic, short, hex, and never returns the input verbatim", () => {
    const raw = "d-abc123-raw-fcm-registration-token"
    const h = hashForLog(raw)
    expect(h).toMatch(/^[0-9a-f]{12}$/)
    expect(h).toBe(hashForLog(raw))
    expect(h).not.toContain(raw)
    expect(hashForLog("other")).not.toBe(h)
  })
})

describe("push(fcm) never logs the raw device token (F021)", () => {
  it("logs a tokenHash and no raw token on a non-prune (transient) failure", async () => {
    const { logger, warns } = recordingLogger()
    const rawToken = "cRAW-FCM-REGISTRATION-TOKEN-xyz"
    sendEachForMulticast.mockResolvedValue({
      responses: [{ success: false, error: { code: "messaging/internal-error" } }],
    })

    const dispatch = makeFcmDispatcher({ serviceAccountJson: "{}" }, logger)
    const { invalidTokens } = await dispatch([rawToken], { title: "Hi" })

    expect(invalidTokens).toEqual([])
    expect(warns).toHaveLength(1)
    const logged = warns[0] as { code: string; tokenHash?: string; token?: string }
    expect(logged.code).toBe("messaging/internal-error")
    expect(logged.tokenHash).toBe(hashForLog(rawToken))
    expect(logged.token).toBeUndefined()
    expect(JSON.stringify(logged)).not.toContain(rawToken)
  })
})
