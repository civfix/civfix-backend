import { describe, it, expect } from "vitest"
import { generateKeyPairSync, createSign, createHash, type KeyObject } from "node:crypto"
import { RemoteJwksVerifier, type FetchLike } from "../../src/auth/jwks.js"
import { AppError, ErrorCode } from "@civfix/shared"

const ISS = "https://accounts.google.com"
const AUD = "test-client-id"
const KID = "test-key-1"

/** Sign a minimal RS256 JWT with the given private key + claims. */
function signJwt(privateKey: KeyObject, claims: Record<string, unknown>): string {
  const header = { alg: "RS256", kid: KID, typ: "JWT" }
  const enc = (o: unknown): string =>
    Buffer.from(JSON.stringify(o)).toString("base64url")
  const signingInput = `${enc(header)}.${enc(claims)}`
  const signer = createSign("RSA-SHA256")
  signer.update(signingInput)
  const sig = signer.sign(privateKey).toString("base64url")
  return `${signingInput}.${sig}`
}

/** Build a verifier whose JWKS fetch returns the public JWK for our generated key. */
function makeVerifier(publicKey: KeyObject, nowSeconds: number) {
  const jwk = { ...(publicKey.export({ format: "jwk" }) as object), kid: KID, alg: "RS256" }
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    json: async () => ({ keys: [jwk] }),
  })
  const verifier = new RemoteJwksVerifier({ fetchImpl, now: () => nowSeconds * 1000 })
  return verifier
}

const params = (nowSeconds: number) => ({
  jwksUrl: "https://example.com/certs",
  issuers: [ISS],
  audience: AUD,
  nowSeconds,
})

async function expectUnauthorized(p: Promise<unknown>): Promise<void> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe(ErrorCode.UNAUTHORIZED)
    return
  }
  throw new Error("expected UNAUTHORIZED")
}

describe("RemoteJwksVerifier", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const NOW = 1_700_000_000

  it("verifies a well-formed token and returns the trusted claims", async () => {
    const token = signJwt(privateKey, {
      iss: ISS,
      aud: AUD,
      sub: "subject-123",
      exp: NOW + 600,
      email: "user@example.com",
      email_verified: true,
      name: "User Example",
    })
    const verifier = makeVerifier(publicKey, NOW)
    const result = await verifier.verify(token, params(NOW))
    expect(result.sub).toBe("subject-123")
    expect(result.email).toBe("user@example.com")
    expect(result.emailVerified).toBe(true)
    expect(result.name).toBe("User Example")
  })

  it("rejects an expired token", async () => {
    const token = signJwt(privateKey, { iss: ISS, aud: AUD, sub: "s", exp: NOW - 1 })
    const verifier = makeVerifier(publicKey, NOW)
    await expectUnauthorized(verifier.verify(token, params(NOW)))
  })

  it("rejects an audience mismatch", async () => {
    const token = signJwt(privateKey, { iss: ISS, aud: "someone-else", sub: "s", exp: NOW + 60 })
    const verifier = makeVerifier(publicKey, NOW)
    await expectUnauthorized(verifier.verify(token, params(NOW)))
  })

  it("rejects an issuer mismatch", async () => {
    const token = signJwt(privateKey, {
      iss: "https://evil.example",
      aud: AUD,
      sub: "s",
      exp: NOW + 60,
    })
    const verifier = makeVerifier(publicKey, NOW)
    await expectUnauthorized(verifier.verify(token, params(NOW)))
  })

  it("rejects a token signed by the wrong key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const token = signJwt(other.privateKey, { iss: ISS, aud: AUD, sub: "s", exp: NOW + 60 })
    // Verifier only knows our public key, not `other`'s.
    const verifier = makeVerifier(publicKey, NOW)
    await expectUnauthorized(verifier.verify(token, params(NOW)))
  })

  it("rejects a malformed token", async () => {
    const verifier = makeVerifier(publicKey, NOW)
    await expectUnauthorized(verifier.verify("not-a-jwt", params(NOW)))
  })

  // P2-3: nonce binding (closes ID-token replay when the client issued a nonce).
  describe("nonce binding (P2-3)", () => {
    it("accepts a token whose nonce claim equals the expected RAW nonce", async () => {
      const token = signJwt(privateKey, {
        iss: ISS,
        aud: AUD,
        sub: "s",
        exp: NOW + 600,
        nonce: "client-nonce-abc",
      })
      const verifier = makeVerifier(publicKey, NOW)
      const result = await verifier.verify(token, {
        ...params(NOW),
        expectedNonce: "client-nonce-abc",
      })
      expect(result.sub).toBe("s")
    })

    it("accepts a token whose nonce claim is the SHA-256 hex of the nonce (Apple native)", async () => {
      const raw = "client-nonce-xyz"
      const hashed = createHash("sha256").update(raw).digest("hex")
      const token = signJwt(privateKey, { iss: ISS, aud: AUD, sub: "s", exp: NOW + 600, nonce: hashed })
      const verifier = makeVerifier(publicKey, NOW)
      const result = await verifier.verify(token, { ...params(NOW), expectedNonce: raw })
      expect(result.sub).toBe("s")
    })

    it("REJECTS a token with a mismatched nonce when one is expected (replay)", async () => {
      const token = signJwt(privateKey, {
        iss: ISS,
        aud: AUD,
        sub: "s",
        exp: NOW + 600,
        nonce: "some-other-nonce",
      })
      const verifier = makeVerifier(publicKey, NOW)
      await expectUnauthorized(verifier.verify(token, { ...params(NOW), expectedNonce: "expected" }))
    })

    it("REJECTS a token with NO nonce claim when one is expected", async () => {
      const token = signJwt(privateKey, { iss: ISS, aud: AUD, sub: "s", exp: NOW + 600 })
      const verifier = makeVerifier(publicKey, NOW)
      await expectUnauthorized(verifier.verify(token, { ...params(NOW), expectedNonce: "expected" }))
    })

    it("ignores the nonce claim when NO nonce is expected (backward compatible)", async () => {
      const token = signJwt(privateKey, {
        iss: ISS,
        aud: AUD,
        sub: "s",
        exp: NOW + 600,
        nonce: "whatever",
      })
      const verifier = makeVerifier(publicKey, NOW)
      const result = await verifier.verify(token, params(NOW)) // no expectedNonce
      expect(result.sub).toBe("s")
    })
  })
})
