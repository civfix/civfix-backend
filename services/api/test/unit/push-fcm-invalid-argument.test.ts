import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PushLogger } from "../../src/adapters/push-sender.js"

type FcmResponse = { success: boolean; error?: { code?: string; message?: string } }

let nextResponses: FcmResponse[] = []

vi.mock("firebase-admin/app", () => ({
  getApps: () => [],
  initializeApp: () => ({ name: "civfix-push" }),
  cert: (value: unknown) => value,
  deleteApp: () => Promise.resolve(),
}))

vi.mock("firebase-admin/messaging", () => ({
  getMessaging: () => ({
    sendEachForMulticast: (message: { tokens: string[] }) =>
      Promise.resolve({ responses: message.tokens.map((_, i) => nextResponses[i]) }),
  }),
}))

const { makeFcmDispatcher } = await import("../../src/adapters/push-fcm.js")

function recordingLogger(): { logger: PushLogger; warns: unknown[][] } {
  const warns: unknown[][] = []
  return {
    logger: { warn: (...args) => warns.push(args), error: () => {} },
    warns,
  }
}

const fcmConfig = { serviceAccountJson: "{}" }
const payload = { title: "New reply" }
const invalidArgument: FcmResponse = {
  success: false,
  error: { code: "messaging/invalid-argument", message: "Message is too big" },
}

beforeEach(() => {
  nextResponses = []
})

describe("FCM dispatcher invalid-argument handling", () => {
  it("prunes nothing when every token in the slice fails with invalid-argument (payload fault)", async () => {
    nextResponses = [invalidArgument, invalidArgument, invalidArgument]
    const { logger, warns } = recordingLogger()

    const result = await makeFcmDispatcher(fcmConfig, logger)(["a", "b", "c"], payload)

    expect(result.invalidTokens).toEqual([])
    const payloadWarns = warns.filter(([, msg]) => String(msg).includes("payload"))
    expect(payloadWarns).toHaveLength(1)
  })

  it("prunes nothing for a single-token slice rejected with invalid-argument", async () => {
    nextResponses = [invalidArgument]
    const { logger } = recordingLogger()

    const result = await makeFcmDispatcher(fcmConfig, logger)(["only"], payload)

    expect(result.invalidTokens).toEqual([])
  })

  it("prunes an invalid-argument token when another token in the slice was accepted", async () => {
    nextResponses = [{ success: true }, invalidArgument]
    const { logger } = recordingLogger()

    const result = await makeFcmDispatcher(fcmConfig, logger)(["good", "malformed"], payload)

    expect(result.invalidTokens).toEqual(["malformed"])
  })

  it("prunes unregistered tokens but keeps invalid-argument ones when nothing in the slice succeeded", async () => {
    nextResponses = [
      { success: false, error: { code: "messaging/registration-token-not-registered" } },
      invalidArgument,
    ]
    const { logger } = recordingLogger()

    const result = await makeFcmDispatcher(fcmConfig, logger)(["gone", "other"], payload)

    expect(result.invalidTokens).toEqual(["gone"])
  })
})
