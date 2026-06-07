/**
 * Unit tests for the Cloudflare Access JWT verifier (doc 16 §6.7).
 *
 * Fully offline: a local RSA keypair is generated, the public key is served via `createLocalJWKSet`
 * (injected into the verifier), and tokens are minted with jose's `SignJWT`. No network / no real CF
 * JWKS. We assert the verifier ACCEPTS a well-formed token and REJECTS the spoofing vectors the security
 * model depends on: wrong `aud`, wrong `iss`, expired, a signature from an unknown key, and a non-RS256
 * `alg` (alg-confusion). It also surfaces the email vs service-token (`common_name`) shapes.
 */

import { describe, it, expect } from "vitest"
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  createLocalJWKSet,
  type JWTVerifyGetKey,
  type KeyLike,
} from "jose"
import { createAccessVerifier } from "../../src/auth/cf-access.js"

const TEAM = "https://civfix.cloudflareaccess.com"
const AUD = "access-app-aud-tag"
const KID = "test-key-1"

async function setup(): Promise<{ privateKey: KeyLike; verify: ReturnType<typeof createAccessVerifier> }> {
  const { publicKey, privateKey } = await generateKeyPair("RS256")
  const jwk = await exportJWK(publicKey)
  jwk.kid = KID
  jwk.alg = "RS256"
  const jwks: JWTVerifyGetKey = createLocalJWKSet({ keys: [jwk] })
  const verify = createAccessVerifier({ teamDomain: TEAM, aud: AUD }, jwks)
  return { privateKey, verify }
}

interface SignOpts {
  iss?: string
  aud?: string
  alg?: string
  expEpoch?: number
}

function sign(
  key: KeyLike,
  claims: Record<string, unknown>,
  opts: SignOpts = {},
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  return new SignJWT(claims)
    .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: KID })
    .setIssuer(opts.iss ?? TEAM)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt(nowSec)
    .setExpirationTime(opts.expEpoch ?? nowSec + 3600)
    .sign(key)
}

describe("createAccessVerifier", () => {
  it("accepts a valid token and returns the verified identity", async () => {
    const { privateKey, verify } = await setup()
    const token = await sign(privateKey, { email: "Ops@Civfix.org", sub: "cf-sub-9" })
    const identity = await verify(token)
    expect(identity.email).toBe("Ops@Civfix.org") // returned as-is; the route lowercases for the allowlist
    expect(identity.sub).toBe("cf-sub-9")
    expect(identity.commonName).toBeNull()
  })

  it("surfaces a service-token shape (common_name, no email)", async () => {
    const { privateKey, verify } = await setup()
    const token = await sign(privateKey, { common_name: "ci-bot.client-id" })
    const identity = await verify(token)
    expect(identity.email).toBeNull()
    expect(identity.commonName).toBe("ci-bot.client-id")
  })

  it("rejects a token with the wrong audience", async () => {
    const { privateKey, verify } = await setup()
    const token = await sign(privateKey, { email: "ops@civfix.org" }, { aud: "some-other-app" })
    await expect(verify(token)).rejects.toThrow()
  })

  it("rejects a token with the wrong issuer", async () => {
    const { privateKey, verify } = await setup()
    const token = await sign(privateKey, { email: "ops@civfix.org" }, { iss: "https://evil.example" })
    await expect(verify(token)).rejects.toThrow()
  })

  it("rejects an expired token (beyond clock tolerance)", async () => {
    const { privateKey, verify } = await setup()
    const expired = Math.floor(Date.now() / 1000) - 120 // 2 min ago, > 30s tolerance
    const token = await sign(privateKey, { email: "ops@civfix.org" }, { expEpoch: expired })
    await expect(verify(token)).rejects.toThrow()
  })

  it("rejects a token signed by an unknown key (bad signature)", async () => {
    const { verify } = await setup()
    const { privateKey: otherKey } = await generateKeyPair("RS256")
    const token = await sign(otherKey, { email: "ops@civfix.org" })
    await expect(verify(token)).rejects.toThrow()
  })

  it("rejects a non-RS256 algorithm (alg-confusion defense)", async () => {
    const { privateKey, verify } = await setup()
    // The same RSA key can sign PS256; the verifier pins RS256, so a PS256 token must be refused.
    const token = await sign(privateKey, { email: "ops@civfix.org" }, { alg: "PS256" })
    await expect(verify(token)).rejects.toThrow()
  })
})
