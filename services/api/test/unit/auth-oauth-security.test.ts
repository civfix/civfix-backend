import { afterEach, describe, expect, it } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import { OAuthService } from "../../src/auth/oauth.js"
import type { JwksVerifier, VerifiedIdToken, VerifyParams } from "../../src/auth/jwks.js"
import { OtpService } from "../../src/auth/otp.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import {
  EmailTakenError,
  InMemoryOAuthIdentityStore,
  InMemoryOtpStore,
  InMemoryUserStore,
} from "../../src/auth/stores.js"
import { makeAuthHarness, type AuthHarness } from "../helpers/auth.js"

const VICTIM_EMAIL = "victim@example.org"
const MAX_DISPLAY_NAME = 80
const SLUR_NAME = "you faggot"

class StubVerifier implements JwksVerifier {
  private readonly map = new Map<string, VerifiedIdToken>()
  register(token: string, claims: VerifiedIdToken): void {
    this.map.set(token, claims)
  }
  verify(idToken: string, _params: VerifyParams): Promise<VerifiedIdToken> {
    const c = this.map.get(idToken)
    return c ? Promise.resolve(c) : Promise.reject(new Error("unknown token"))
  }
}

function claims(
  sub: string,
  email: string | null,
  opts: { verified?: boolean; name?: string | null } = {},
): VerifiedIdToken {
  return {
    sub,
    email,
    emailVerified: opts.verified ?? true,
    name: opts.name ?? null,
    picture: null,
  }
}

function makeServices() {
  const nowMs = { value: 1_700_000_000_000 }
  const users = new InMemoryUserStore()
  const oauthStore = new InMemoryOAuthIdentityStore()
  const verifier = new StubVerifier()
  const oauth = new OAuthService({
    config: {
      google: { clientId: "gid", clientSecret: "gsecret", redirectUri: "http://localhost/cb" },
      apple: {
        clientId: "aid",
        teamId: "team",
        keyId: "key",
        privateKey: "pk",
        redirectUri: "http://localhost/apple/cb",
      },
    },
    oauthStore,
    users,
    verifier,
  })
  const mailer = new FakeMailer()
  const otp = new OtpService({
    store: new InMemoryOtpStore(),
    users,
    cache: new InMemoryCacheClient(() => nowMs.value),
    mailer,
    now: () => nowMs.value,
  })
  return { oauth, otp, mailer, users, oauthStore, verifier }
}

describe("provider sign-in with an unverified email", () => {
  it("never adopts the existing account that owns the address", async () => {
    const { oauth, users, oauthStore, verifier } = makeServices()
    const victim = await users.create(VICTIM_EMAIL, {
      displayName: "Victim",
      role: "operator",
      emailVerified: true,
    })
    verifier.register("t", claims("attacker-sub", "Victim@Example.org", { verified: false }))

    const signedIn = await oauth.signInWithGoogleIdToken("t")

    expect(signedIn.id).not.toBe(victim.id)
    expect(signedIn.role).toBe("citizen")
    expect(signedIn.email).toBeNull()
    expect(signedIn.emailVerified).toBe(false)
    expect((await oauthStore.findByProvider("google", "attacker-sub"))?.userId).toBe(signedIn.id)
    expect((await users.findById(victim.id))?.email).toBe(VICTIM_EMAIL)
  })

  it("does not plant the address for a later email-code sign-in to walk into", async () => {
    const { oauth, otp, mailer, verifier } = makeServices()
    verifier.register("t", claims("attacker-sub", VICTIM_EMAIL, { verified: false }))
    const attacker = await oauth.signInWithGoogleIdToken("t")

    await otp.issueOtp(VICTIM_EMAIL, null)
    const ownerId = await otp.verifyOtp(VICTIM_EMAIL, mailer.lastOtpFor(VICTIM_EMAIL)!, null)

    expect(ownerId).not.toBe(attacker.id)
    const again = await oauth.signInWithGoogleIdToken("t")
    expect(again.id).toBe(attacker.id)
  })

  it("keeps the verified-email link for the account that owns the address", async () => {
    const { oauth, users, verifier } = makeServices()
    const owner = await users.create(VICTIM_EMAIL, { displayName: "Owner", emailVerified: true })
    verifier.register("t", claims("owner-sub", VICTIM_EMAIL))

    expect((await oauth.signInWithGoogleIdToken("t")).id).toBe(owner.id)
  })
})

describe("strict user creation for provider sign-in", () => {
  it("rejects an email that another account holds instead of returning that account", async () => {
    const users = new InMemoryUserStore()
    await users.create(VICTIM_EMAIL, { displayName: "Victim", emailVerified: true })

    await expect(
      users.create("VICTIM@example.org", { displayName: "Other", onEmailConflict: "reject" }),
    ).rejects.toBeInstanceOf(EmailTakenError)
  })

  it("links the winner when two verified first sign-ins race on one address", async () => {
    const { oauth, users, oauthStore, verifier } = makeServices()
    verifier.register("t", claims("racer-sub", VICTIM_EMAIL))
    const winner = await users.create(VICTIM_EMAIL, { displayName: "Winner", emailVerified: true })
    const findByEmail = users.findByEmail.bind(users)
    let calls = 0
    users.findByEmail = (email: string) => {
      calls += 1
      return calls === 1 ? Promise.resolve(null) : findByEmail(email)
    }

    const signedIn = await oauth.signInWithGoogleIdToken("t")

    expect(signedIn.id).toBe(winner.id)
    expect((await oauthStore.findByProvider("google", "racer-sub"))?.userId).toBe(winner.id)
  })
})

describe("provider-supplied display names", () => {
  it("caps an oversized Apple fullName", async () => {
    const { oauth, verifier } = makeServices()
    verifier.register("a", claims("apple-sub", "long@example.com"))

    const user = await oauth.signInWithAppleIdToken("a", `  ${"x".repeat(5000)}  `)

    expect(user.displayName.length).toBeLessThanOrEqual(MAX_DISPLAY_NAME)
    expect(user.displayName).toBe("x".repeat(MAX_DISPLAY_NAME))
  })

  it("collapses runs of whitespace in the Apple fullName", async () => {
    const { oauth, verifier } = makeServices()
    verifier.register("a", claims("apple-sub", "ws@example.com"))

    const user = await oauth.signInWithAppleIdToken("a", "  Ada \n\t  Lovelace ")

    expect(user.displayName).toBe("Ada Lovelace")
  })

  it("replaces a slur Apple fullName with the name derived from the token", async () => {
    const { oauth, verifier } = makeServices()
    verifier.register("a", claims("apple-sub", "jordan@example.com"))

    const user = await oauth.signInWithAppleIdToken("a", SLUR_NAME)

    expect(user.displayName).toBe("jordan")
  })

  it("replaces a slur Google name claim with the email local part", async () => {
    const { oauth, verifier } = makeServices()
    verifier.register("g", claims("google-sub", "casey@example.com", { name: SLUR_NAME }))

    const user = await oauth.signInWithGoogleIdToken("g")

    expect(user.displayName).toBe("casey")
  })

  it("falls back to the generic provider label when every candidate is a slur", async () => {
    const { oauth, verifier } = makeServices()
    verifier.register("g", claims("google-sub", "faggot@example.com", { name: SLUR_NAME }))
    verifier.register("a", claims("apple-sub", null))

    expect((await oauth.signInWithGoogleIdToken("g")).displayName).toBe("Google user")
    expect((await oauth.signInWithAppleIdToken("a", SLUR_NAME)).displayName).toBe("Apple user")
  })

  it("falls back when the fullName is only whitespace", async () => {
    const { oauth, verifier } = makeServices()
    verifier.register("a", claims("apple-sub", null))

    expect((await oauth.signInWithAppleIdToken("a", " \n ")).displayName).toBe("Apple user")
  })
})

describe("POST /v1/auth/google with an unverified email", () => {
  let harness: AuthHarness | undefined
  afterEach(async () => {
    await harness?.app.close()
    harness = undefined
  })

  it("mints a session for a new account, not for the account that owns the address", async () => {
    harness = await makeAuthHarness()
    const victim = await harness.signIn(VICTIM_EMAIL)
    harness.verifier.register("attacker-token", {
      sub: "attacker-sub",
      email: VICTIM_EMAIL,
      emailVerified: false,
      name: null,
      picture: null,
    })

    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/google",
      headers: { "x-client": "mobile" },
      payload: { idToken: "attacker-token" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { user: { id: string; email: string | null }; token: string }
    expect(body.user.id).not.toBe(victim.userId)
    expect(body.user.email ?? null).toBeNull()
    const session = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { authorization: `Bearer ${body.token}` },
    })
    expect(session.json().user.id).not.toBe(victim.userId)
  })
})
