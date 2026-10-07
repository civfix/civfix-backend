import { describe, it, expect, afterEach } from "vitest"
import { makeAuthHarness, bearer, type AuthHarness } from "../helpers/auth.js"

let harness: AuthHarness | undefined

afterEach(async () => {
  if (harness) {
    await harness.app.close()
    harness = undefined
  }
})

async function suspendWithoutRevoking(h: AuthHarness, userId: string): Promise<void> {
  h.stores.users.setAccountStatus(userId, "suspended")
  h.stores.sessions.setAccountStatus(userId, "suspended")
  await h.services.sessions.bumpEpoch(userId)
}

describe("H4: suspended accounts are read-only", () => {
  it("a live suspended session may READ but not WRITE", async () => {
    harness = await makeAuthHarness()
    const { token, userId } = await harness.signIn("suspended.reader@example.com")
    await suspendWithoutRevoking(harness, userId)

    const read = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: bearer(token),
    })
    expect(read.statusCode).toBe(200)
    expect(read.json().user.id).toBe(userId)

    const write = await harness.app.inject({
      method: "POST",
      url: "/v1/ws-ticket",
      headers: bearer(token),
    })
    expect(write.statusCode).toBe(403)
    expect(write.json().code).toBe("FORBIDDEN")
  })

  it("logout and account deletion stay open so a suspended user can still leave", async () => {
    harness = await makeAuthHarness()
    const { token, userId } = await harness.signIn("suspended.leaver@example.com")
    await suspendWithoutRevoking(harness, userId)

    const otp = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/otp/request",
      headers: bearer(token),
      payload: { email: "suspended.leaver@example.com" },
    })
    expect(otp.statusCode).toBe(200)

    const out = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: bearer(token),
    })
    expect(out.statusCode).toBe(200)
  })

  it("an ACTIVE session is unaffected by the guard", async () => {
    harness = await makeAuthHarness()
    const { token } = await harness.signIn("active.writer@example.com")
    const write = await harness.app.inject({
      method: "POST",
      url: "/v1/ws-ticket",
      headers: bearer(token),
    })
    expect(write.statusCode).toBe(200)
  })

  it("REVIEW is a flag only; it restricts nothing", async () => {
    harness = await makeAuthHarness()
    const { token, userId } = await harness.signIn("under.review@example.com")
    harness.stores.users.setAccountStatus(userId, "review")
    harness.stores.sessions.setAccountStatus(userId, "review")
    await harness.services.sessions.bumpEpoch(userId)

    const write = await harness.app.inject({
      method: "POST",
      url: "/v1/ws-ticket",
      headers: bearer(token),
    })
    expect(write.statusCode).toBe(200)
  })

  it("setting the status to suspended revokes every session (the token stops authenticating)", async () => {
    harness = await makeAuthHarness()
    const { token, userId } = await harness.signIn("suspend.now@example.com")
    harness.stores.users.setAccountStatus(userId, "suspended")
    harness.stores.sessions.setAccountStatus(userId, "suspended")
    await harness.services.sessions.applyAccountStatus(userId, "suspended")

    const read = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: bearer(token),
    })
    expect(read.json().user).toBeFalsy()
  })

  it("a suspended account cannot sign in again", async () => {
    harness = await makeAuthHarness()
    const email = "suspended.login@example.com"
    const { userId } = await harness.signIn(email)
    harness.stores.users.setAccountStatus(userId, "suspended")

    const requested = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/otp/request",
      payload: { email },
    })
    expect(requested.statusCode).toBe(200)
    const code = harness.mailer.lastOtpFor(email)
    const verified = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      headers: { "x-client": "mobile" },
      payload: { email, code },
    })
    expect(verified.statusCode).toBe(403)
  })

  it("suspended -> active restores writing and sign-in", async () => {
    harness = await makeAuthHarness()
    const email = "reinstated@example.com"
    const first = await harness.signIn(email)
    harness.stores.users.setAccountStatus(first.userId, "suspended")
    harness.stores.sessions.setAccountStatus(first.userId, "suspended")
    await harness.services.sessions.applyAccountStatus(first.userId, "suspended")

    harness.stores.users.setAccountStatus(first.userId, "active")
    harness.stores.sessions.setAccountStatus(first.userId, "active")
    await harness.services.sessions.applyAccountStatus(first.userId, "active")

    const again = await harness.signIn(email)
    expect(again.userId).toBe(first.userId)
    const write = await harness.app.inject({
      method: "POST",
      url: "/v1/ws-ticket",
      headers: bearer(again.token),
    })
    expect(write.statusCode).toBe(200)
  })
})
