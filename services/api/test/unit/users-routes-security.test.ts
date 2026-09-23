import { afterEach, describe, expect, it } from "vitest"
import { makeAuthHarness, type AuthHarness } from "../helpers/auth.js"

const EMAIL = "leaving@example.com"

let harness: AuthHarness | undefined
afterEach(async () => {
  await harness?.app.close()
  harness = undefined
})

describe("DELETE /v1/me after the erasure commits", () => {
  it("reports the deletion as done when the session ban marker cannot be written", async () => {
    harness = await makeAuthHarness()
    const { token, userId } = await harness.signIn(EMAIL)
    await harness.app.inject({
      method: "POST",
      url: "/v1/auth/otp/request",
      payload: { email: EMAIL },
    })
    const code = harness.mailer.lastOtpFor(EMAIL)!
    let banAttempts = 0
    harness.services.sessions.banUser = () => {
      banAttempts += 1
      return Promise.reject(new Error("redis unavailable"))
    }

    const res = await harness.app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
      payload: { emailOtp: code },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(banAttempts).toBe(1)
    expect((await harness.stores.users.findById(userId))?.deletedAt ?? null).not.toBeNull()
  })
})
