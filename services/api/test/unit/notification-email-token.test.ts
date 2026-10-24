// GH#225 / D10: a notification email's "Stop these emails" link carries an `n1` token, an HMAC over
// `n1.<body>` with UNSUBSCRIBE_SIGNING_KEY. It shares the key with the broadcast `u1` token, so each
// verifier must refuse the other's token.

import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  mintNotificationEmailToken,
  notificationEmailExpiryFrom,
  verifyNotificationEmailToken,
} from "../../src/services/notification-email-token.js"
import {
  mintUnsubscribeToken,
  unsubscribeExpiryFrom,
  verifyUnsubscribeToken,
} from "../../src/services/host/broadcast-capability-token.js"

const K = "notification-email-signing-key-for-tests-0123"
const U = "aaaaaaaa-0000-4000-8000-000000000001"
const EVENT = "eeeeeeee-0000-4000-8000-00000000000e"
const T = Date.parse("2026-10-24T12:00:00.250Z")
const DAY_MS = 24 * 60 * 60 * 1000
const E = T + 30 * DAY_MS

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

function handToken(payload: unknown, key = K, prefix = "n1"): string {
  const body = b64(JSON.stringify(payload))
  const sig = createHmac("sha256", key).update(`${prefix}.${body}`).digest("base64url")
  return `${prefix}.${body}.${sig}`
}

describe("notification email tokens", () => {
  it("T30: mints n1.<body>.<sig> over {v, i, c, x}, and a hand-built token verifies", () => {
    const token = mintNotificationEmailToken({ userId: U, category: "events", expiresAtMs: E }, K)
    const x = Math.floor(E / 1000)
    const expected = handToken({ v: 1, i: U, c: "events", x })

    expect(token).toBe(expected)
    const [prefix, body] = token.split(".")
    expect(prefix).toBe("n1")
    expect(JSON.parse(Buffer.from(body!, "base64url").toString("utf8"))).toEqual({
      v: 1,
      i: U,
      c: "events",
      x,
    })
    expect(verifyNotificationEmailToken(expected, K, T)).toEqual({
      userId: U,
      category: "events",
      expiresAtMs: x * 1000,
    })
  })

  it("T31: a token with the default expiry verifies until 400 days after minting, not at it", () => {
    const token = mintNotificationEmailToken(
      { userId: U, category: "followers", expiresAtMs: notificationEmailExpiryFrom(T) },
      K,
    )

    expect(verifyNotificationEmailToken(token, K, T + 400 * DAY_MS - 1000)).toMatchObject({
      userId: U,
      category: "followers",
    })
    expect(verifyNotificationEmailToken(token, K, T + 400 * DAY_MS)).toBeNull()
  })

  it("T32: refuses tampered, foreign-key, wrong-prefix, unknown-category, wrong-version and four-part tokens", () => {
    const x = Math.floor(E / 1000)
    const good = handToken({ v: 1, i: U, c: "events", x })
    const [prefix, body, sig] = good.split(".") as [string, string, string]
    const otherBody = b64(JSON.stringify({ v: 1, i: U, c: "followers", x }))
    const flipped = sig.startsWith("A") ? `B${sig.slice(1)}` : `A${sig.slice(1)}`

    const refused = {
      tamperedBody: `${prefix}.${otherBody}.${sig}`,
      tamperedSignature: `${prefix}.${body}.${flipped}`,
      differentKey: handToken(
        { v: 1, i: U, c: "events", x },
        "a-completely-different-key-0123456789",
      ),
      prefixN2: handToken({ v: 1, i: U, c: "events", x }, K, "n2"),
      unknownCategory: handToken({ v: 1, i: U, c: "newsletter", x }),
      version2: handToken({ v: 2, i: U, c: "events", x }),
      fourParts: `${good}.extra`,
    }
    for (const [name, token] of Object.entries(refused)) {
      expect(verifyNotificationEmailToken(token, K, T), name).toBeNull()
    }
  })

  it("T33: a broadcast u1 token is no notification token, and an n1 token is no broadcast token", () => {
    const u1 = mintUnsubscribeToken(
      {
        subjectKind: "user",
        subjectId: U,
        cleanupId: EVENT,
        expiresAtMs: unsubscribeExpiryFrom(T),
      },
      K,
    )
    const n1 = mintNotificationEmailToken(
      { userId: U, category: "events", expiresAtMs: notificationEmailExpiryFrom(T) },
      K,
    )

    expect(verifyUnsubscribeToken(u1, K, T)).not.toBeNull()
    expect(verifyNotificationEmailToken(n1, K, T)).not.toBeNull()
    expect(verifyNotificationEmailToken(u1, K, T)).toBeNull()
    expect(verifyUnsubscribeToken(n1, K, T)).toBeNull()
  })
})
