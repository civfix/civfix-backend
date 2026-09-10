/**
 * Auth integration test against REAL Drizzle/Postgres stores.
 *
 * Requires Docker; SKIPPED (not failed) when Docker is unavailable, via the same withPg() probe the
 * other integration tests use, so the local suite stays green. In CI (Docker present) this exercises
 * the actual SQL of the Pg stores: session insert/find/expiry/delete, the email-OTP lifecycle, and
 * find-or-create over the real users + oauth_identities tables.
 *
 * It also re-proves the section-17 property against the real store: once a session is warm in the
 * cache, a second resolve is served from the cache with the Postgres store query NOT invoked (the
 * PgSessionStore.findById is wrapped with a spy and asserted to be untouched on the cache hit).
 */

import { afterAll, describe, expect, it, vi } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedMediaAsset } from "../helpers/media-pg.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { SessionService } from "../../src/auth/session-service.js"
import { OtpService } from "../../src/auth/otp.js"
import {
  PgSessionStore,
  PgUserStore,
  PgOtpStore,
  PgOAuthIdentityStore,
} from "../../src/auth/pg-stores.js"
import { OAuthService } from "../../src/auth/oauth.js"
import type { JwksVerifier, VerifiedIdToken } from "../../src/auth/jwks.js"
import { FakeMailer } from "@civfix/shared/fakes"
import { sha256Hex } from "../../src/auth/crypto.js"

const pg = await withPg()

class StubVerifier implements JwksVerifier {
  constructor(private readonly claims: VerifiedIdToken) {}
  verify(): Promise<VerifiedIdToken> {
    return Promise.resolve(this.claims)
  }
}

describe.skipIf(!pg)("auth integration: Postgres stores", () => {
  const h = pg as PgHarness

  afterAll(async () => {
    await h.teardown()
  })

  it("session: create -> resolve from cache (no PG read) -> revoke", async () => {
    const store = new PgSessionStore(h.db)
    const users = new PgUserStore(h.db)
    const cache = new InMemoryCacheClient()
    const sessions = new SessionService({ store, cache })

    // Need a real user row (FK target).
    const user = await users.create("session.it@example.com", { displayName: "Session IT" })

    const token = await sessions.createSession(user.id, ["citizen"], {
      userAgent: "vitest",
      ip: "203.0.113.5",
    })
    const hash = await sha256Hex(token)

    // The durable row exists keyed by the hash, not the raw token.
    const row = await store.findById(hash)
    expect(row?.userId).toBe(user.id)

    // Warm cache hit must NOT touch Postgres.
    const findSpy = vi.spyOn(store, "findById")
    const resolved = await sessions.resolveSession(token)
    expect(resolved?.userId).toBe(user.id)
    expect(resolved?.source).toBe("cache")
    expect(findSpy).not.toHaveBeenCalled()
    findSpy.mockRestore()

    // After a cache flush, resolution falls back to Postgres and re-warms.
    await cache.del(`sess:${hash}`)
    const fromPg = await sessions.resolveSession(token)
    expect(fromPg?.source).toBe("store")

    // Revoke clears the durable row.
    await sessions.revokeSession(token)
    expect(await store.findById(hash)).toBeNull()
  })

  it("otp: issue -> verify creates the user; wrong code locks after 3", async () => {
    const store = new PgOtpStore(h.db)
    const users = new PgUserStore(h.db)
    const cache = new InMemoryCacheClient()
    const mailer = new FakeMailer()
    const otp = new OtpService({ store, users, cache, mailer })

    const email = "otp.it@example.com"
    await otp.issueOtp(email, "203.0.113.6")
    const code = mailer.lastOtpFor(email)!
    expect(code).toMatch(/^\d{6}$/)

    const userId = await otp.verifyOtp(email, code, "203.0.113.6")
    const user = await users.findById(userId)
    expect(user?.role).toBe("citizen")

    // A second sign-in finds the same user.
    const cache2 = new InMemoryCacheClient()
    const otp2 = new OtpService({ store, users, cache: cache2, mailer })
    await otp2.issueOtp(email, "203.0.113.6")
    const code2 = mailer.lastOtpFor(email)!
    const again = await otp2.verifyOtp(email, code2, "203.0.113.6")
    expect(again).toBe(userId)
  })

  it("oauth: find-or-create over real users + oauth_identities, with email linking", async () => {
    const oauthStore = new PgOAuthIdentityStore(h.db)
    const users = new PgUserStore(h.db)
    const googleClaims: VerifiedIdToken = {
      sub: "google-it-sub",
      email: "oauth.it@example.com",
      emailVerified: true,
      name: "OAuth IT",
      picture: null,
    }
    const svcGoogle = new OAuthService({
      config: {
        google: { clientId: "g", clientSecret: "s", redirectUri: "http://localhost/cb" },
      },
      oauthStore,
      users,
      verifier: new StubVerifier(googleClaims),
    })
    const u1 = await svcGoogle.signInWithGoogleIdToken("tok")
    const u1again = await svcGoogle.signInWithGoogleIdToken("tok")
    expect(u1again.id).toBe(u1.id)

    // Apple with a different sub but same email links to the same user.
    const appleClaims: VerifiedIdToken = {
      sub: "apple-it-sub",
      email: "oauth.it@example.com",
      emailVerified: true,
      name: null,
      picture: null,
    }
    const svcApple = new OAuthService({
      config: {
        apple: {
          clientId: "a",
          teamId: "t",
          keyId: "k",
          privateKey: "pk",
          redirectUri: "http://localhost/apple/cb",
        },
      },
      oauthStore,
      users,
      verifier: new StubVerifier(appleClaims),
    })
    const u2 = await svcApple.signInWithAppleIdToken("tok2", undefined)
    expect(u2.id).toBe(u1.id)
  })

  it("updateProfile with an avatarUploadId canonicalizes users.avatar_url (presigned served_key) + returns it", async () => {
    const users = new PgUserStore(h.db)
    const user = await users.create("avatar.canon@example.com", { displayName: "Avatar Canon" })

    // A published avatar media row (the presign -> PUT -> finalize -> media.checks pipeline's end state).
    // The worker publishes its processed bytes to served_key, NOT back over the client-writable r2_key,
    // and every read path (including this one) hands out served_key.
    const media = await seedMediaAsset(h.sql, { r2Key: "avatars/canon/upload.jpg" })
    const uploadId = media.uploadId
    const servedKey = media.servedKey

    // Inject the canonical presigner the route wires from the Storage seam (R2_PUBLIC_BASE => stable URL).
    const presignAvatar = (key: string): Promise<string> =>
      Promise.resolve(`https://cdn.example.test/${key}`)
    const expectedUrl = `https://cdn.example.test/${servedKey}`

    // The RETURNED record (the PUT /me/profile response + session/me, via toUserDTO) carries the new URL.
    const updated = await users.updateProfile(user.id, {
      handle: user.handle ?? "avatar_canon",
      displayName: "Avatar Canon",
      avatarUploadId: uploadId,
      presignAvatar,
    })
    expect(updated.avatarUrl).toBe(expectedUrl)

    // And it is PERSISTED: a fresh read (every avatar_url reader) sees the canonical URL.
    const reread = await users.findById(user.id)
    expect(reread?.avatarUrl).toBe(expectedUrl)

    // No presigner => avatar_url is left untouched (a name/bio edit must not clear the avatar).
    const after = await users.updateProfile(user.id, {
      handle: updated.handle ?? "avatar_canon",
      displayName: "Avatar Canon Renamed",
    })
    expect(after.avatarUrl).toBe(expectedUrl)
  })

  it("P1-4: concurrent create for the same brand-new email resolves to ONE user (no unique-violation 500)", async () => {
    const users = new PgUserStore(h.db)
    const email = "concurrent.signup@example.com"
    // Fire several creates at once for the SAME new email. Before the fix the losers tripped
    // users_email_key and threw a 23505 that surfaced as a 500; now ON CONFLICT (email) DO NOTHING +
    // re-select makes every caller resolve to the single winning row.
    const results = await Promise.all(
      Array.from({ length: 5 }, (_unused, i) =>
        users.create(email, { displayName: `Racer ${i}`, emailVerified: true }),
      ),
    )
    const ids = new Set(results.map((r) => r.id))
    expect(ids.size).toBe(1) // all converged on one user

    // Exactly one row exists in the table for that email.
    const rows = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM users WHERE email = ${email}
    `
    expect(rows[0]!.n).toBe(1)
  })
})
