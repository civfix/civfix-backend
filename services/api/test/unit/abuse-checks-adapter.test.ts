import { afterEach, describe, it, expect, vi } from "vitest"
import { RealAbuseChecks } from "../../src/adapters/abuse-checks.js"

/**
 * Unit tests for the REAL AbuseChecks adapter, focused on the P1 regression: nsfwScore/pHash/
 * isNearDuplicate used to reject with "not implemented", which made the media.checks worker fail CLOSED
 * and hold 100% of media forever (so anon hold-release never published). These tests prove the adapter
 * now NEVER throws on those paths and DEFAULTS TO BENIGN, so default-flag production publishes media.
 *
 * Turnstile + gpsPlausible stay real and are unchanged; gpsPlausible (a pure distance check) is covered
 * here too to confirm the decoupling did not disturb it.
 */

const IMG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8])

describe("RealAbuseChecks.nsfwScore (default benign, never throws)", () => {
  it("returns 0 (benign) by default and logs the not-configured notice ONCE", async () => {
    const lines: string[] = []
    const abuse = new RealAbuseChecks({ log: (l) => lines.push(l) })

    await expect(abuse.nsfwScore(IMG)).resolves.toBe(0)
    await expect(abuse.nsfwScore(IMG)).resolves.toBe(0)
    await expect(abuse.nsfwScore(new Uint8Array([9, 9, 9]))).resolves.toBe(0)

    // One-shot notice: logged exactly once across many scores (not per asset).
    const notices = lines.filter((l) => l.includes("NSFW model not configured"))
    expect(notices).toHaveLength(1)
  })

  it("USE_REAL_NSFW=true but no model wired still returns benign (logs, does NOT throw)", async () => {
    const lines: string[] = []
    const abuse = new RealAbuseChecks({ useRealNsfw: true, log: (l) => lines.push(l) })
    await expect(abuse.nsfwScore(IMG)).resolves.toBe(0)
    expect(lines.some((l) => l.includes("not configured"))).toBe(true)
  })

  it("USE_REAL_NSFW=true WITH a model scores for real", async () => {
    const nsfwModel = vi.fn().mockResolvedValue(0.92)
    const abuse = new RealAbuseChecks({ useRealNsfw: true, nsfwModel })
    await expect(abuse.nsfwScore(IMG)).resolves.toBe(0.92)
    expect(nsfwModel).toHaveBeenCalledOnce()
  })

  it("a wired model is NOT used while the flag is off (stays benign)", async () => {
    const nsfwModel = vi.fn().mockResolvedValue(1)
    const abuse = new RealAbuseChecks({ useRealNsfw: false, nsfwModel })
    await expect(abuse.nsfwScore(IMG)).resolves.toBe(0)
    expect(nsfwModel).not.toHaveBeenCalled()
  })
})

describe("RealAbuseChecks.pHash (real hash, never throws)", () => {
  it("returns a stable 16-char hex by default (no injected hasher)", async () => {
    const abuse = new RealAbuseChecks()
    const a = await abuse.pHash(IMG)
    const b = await abuse.pHash(IMG)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(a).toBe(b) // deterministic
    // Different bytes -> (almost certainly) different hash.
    const c = await abuse.pHash(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
    expect(c).not.toBe(a)
  })

  it("delegates to the injected perceptual hasher when provided", async () => {
    const perceptualHash = vi.fn().mockResolvedValue("deadbeefdeadbeef")
    const abuse = new RealAbuseChecks({ perceptualHash })
    await expect(abuse.pHash(IMG)).resolves.toBe("deadbeefdeadbeef")
    expect(perceptualHash).toHaveBeenCalledOnce()
  })
})

describe("RealAbuseChecks.isNearDuplicate (benign default, never throws)", () => {
  it("returns { dup: false } by default (no lookup wired)", async () => {
    const abuse = new RealAbuseChecks()
    await expect(abuse.isNearDuplicate("abc123")).resolves.toEqual({ dup: false })
  })

  it("delegates to the injected lookup when provided", async () => {
    const findPhashDuplicate = vi
      .fn()
      .mockResolvedValue({ dup: true, ofReportId: "report-1" })
    const abuse = new RealAbuseChecks({ findPhashDuplicate })
    await expect(abuse.isNearDuplicate("abc123")).resolves.toEqual({
      dup: true,
      ofReportId: "report-1",
    })
    expect(findPhashDuplicate).toHaveBeenCalledWith("abc123")
  })
})

describe("RealAbuseChecks.gpsPlausible (unchanged; decoupled from NSFW)", () => {
  const abuse = new RealAbuseChecks()
  it("is plausible with no signals", async () => {
    await expect(abuse.gpsPlausible({ lat: 34.1, lng: -118.35 }, null)).resolves.toBe(true)
  })
  it("is implausible when the point is far from the IP geo (> ~50km)", async () => {
    await expect(
      abuse.gpsPlausible({ lat: 34.7, lng: -118.35 }, { lat: 34.1, lng: -118.35 }),
    ).resolves.toBe(false)
  })
  it("is plausible just inside the threshold", async () => {
    await expect(
      abuse.gpsPlausible({ lat: 34.5, lng: -118.35 }, { lat: 34.1, lng: -118.35 }),
    ).resolves.toBe(true)
  })
})

/**
 * L16 — the siteverify response carries `hostname` and `action` precisely so the server can bind a
 * token to the page that issued it. Ignoring them meant a token minted on ANY page using our sitekey
 * could be replayed against the highest-value endpoint. M9 — `hasNsfwScorer()` makes "no model wired"
 * an explicit, inspectable state instead of an invisible benign default.
 */
describe("RealAbuseChecks.verifyTurnstile hostname/action binding (L16)", () => {
  const originalFetch = globalThis.fetch

  function stubSiteverify(body: Record<string, unknown>): void {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    }) as unknown as typeof fetch
  }

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("rejects a successful token issued on an UNEXPECTED hostname", async () => {
    stubSiteverify({ success: true, hostname: "attacker.example" })
    const abuse = new RealAbuseChecks({
      turnstileSecret: "s",
      turnstileHostnames: ["civfix.org", "www.civfix.org"],
      log: () => {},
    })
    await expect(abuse.verifyTurnstile("tok", "1.2.3.4")).resolves.toBe(false)
  })

  it("accepts a successful token from an expected hostname (case-insensitive)", async () => {
    stubSiteverify({ success: true, hostname: "CIVFIX.ORG" })
    const abuse = new RealAbuseChecks({
      turnstileSecret: "s",
      turnstileHostnames: ["civfix.org"],
      log: () => {},
    })
    await expect(abuse.verifyTurnstile("tok", "1.2.3.4")).resolves.toBe(true)
  })

  it("rejects when the action does not match the per-form constant", async () => {
    stubSiteverify({ success: true, hostname: "civfix.org", action: "login" })
    const abuse = new RealAbuseChecks({
      turnstileSecret: "s",
      turnstileHostnames: ["civfix.org"],
      log: () => {},
    })
    await expect(abuse.verifyTurnstile("tok", "1.2.3.4", { action: "home-turf" })).resolves.toBe(false)
    await expect(abuse.verifyTurnstile("tok", "1.2.3.4", { action: "login" })).resolves.toBe(true)
  })

  it("skips the hostname assertion when unconfigured, but logs the gap ONCE", async () => {
    stubSiteverify({ success: true, hostname: "anything.example" })
    const lines: string[] = []
    const abuse = new RealAbuseChecks({ turnstileSecret: "s", log: (l) => lines.push(l) })
    await expect(abuse.verifyTurnstile("tok", "1.2.3.4")).resolves.toBe(true)
    await expect(abuse.verifyTurnstile("tok", "1.2.3.4")).resolves.toBe(true)
    expect(lines.filter((l) => l.includes("hostname binding not configured"))).toHaveLength(1)
  })

  it("a failed challenge is still false regardless of hostname/action", async () => {
    stubSiteverify({ success: false, hostname: "civfix.org" })
    const abuse = new RealAbuseChecks({ turnstileSecret: "s", turnstileHostnames: ["civfix.org"] })
    await expect(abuse.verifyTurnstile("tok", "1.2.3.4")).resolves.toBe(false)
  })
})

describe("RealAbuseChecks.hasNsfwScorer (M9)", () => {
  it("is false with no model and false when the flag is on but nothing is wired", () => {
    expect(new RealAbuseChecks({ log: () => {} }).hasNsfwScorer()).toBe(false)
    expect(new RealAbuseChecks({ useRealNsfw: true, log: () => {} }).hasNsfwScorer()).toBe(false)
  })

  it("is true only when the flag is on AND a model is wired", () => {
    const abuse = new RealAbuseChecks({ useRealNsfw: true, nsfwModel: () => Promise.resolve(0.1) })
    expect(abuse.hasNsfwScorer()).toBe(true)
  })
})
