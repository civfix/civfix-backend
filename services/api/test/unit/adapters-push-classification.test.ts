/**
 * The prune-vs-warn matrix of every push dispatcher, tested as pure functions.
 *
 * Getting this wrong is expensive in both directions: classifying a TRANSIENT failure as "prune" revokes a
 * live device's token (the user silently stops receiving push), while failing to classify a DEAD token
 * leaves it in push_tokens forever and every future send re-attempts it. Only the Expo dispatcher had
 * coverage; APNs/FCM/WebPush had none because the classification was buried inside SDK-calling factories.
 */

import { describe, it, expect, vi } from "vitest"
import { isApnsPruneFailure } from "../../src/adapters/push-apns.js"
import { isFcmPruneCode } from "../../src/adapters/push-fcm.js"
import { classifyWebPushError } from "../../src/adapters/push-webpush.js"
import { collectExpoInvalidTokens, makeExpoDispatcher } from "../../src/adapters/push-expo.js"
import type { PushLogger } from "../../src/adapters/push-sender.js"

function recordingLogger(): { logger: PushLogger; warns: unknown[]; errors: unknown[] } {
  const warns: unknown[] = []
  const errors: unknown[] = []
  return {
    logger: { warn: (obj) => warns.push(obj), error: (obj) => errors.push(obj) },
    warns,
    errors,
  }
}

describe("isApnsPruneFailure", () => {
  it("prunes on 410 / Unregistered / BadDeviceToken", () => {
    expect(isApnsPruneFailure("410", "")).toBe(true)
    expect(isApnsPruneFailure("400", "Unregistered")).toBe(true)
    expect(isApnsPruneFailure("400", "BadDeviceToken")).toBe(true)
  })

  it("does NOT prune on transient or unrelated failures", () => {
    expect(isApnsPruneFailure("429", "TooManyRequests")).toBe(false)
    expect(isApnsPruneFailure("500", "InternalServerError")).toBe(false)
    expect(isApnsPruneFailure("503", "ServiceUnavailable")).toBe(false)
    expect(isApnsPruneFailure("403", "ExpiredProviderToken")).toBe(false)
    expect(isApnsPruneFailure("400", "BadTopic")).toBe(false)
    expect(isApnsPruneFailure("", "")).toBe(false)
  })
})

describe("isFcmPruneCode", () => {
  it("prunes only the dead-token codes", () => {
    expect(isFcmPruneCode("messaging/registration-token-not-registered")).toBe(true)
    expect(isFcmPruneCode("messaging/invalid-registration-token")).toBe(true)
    expect(isFcmPruneCode("messaging/invalid-argument")).toBe(false)
  })

  it("warns (does not prune) on transient/quota codes and unknown values", () => {
    expect(isFcmPruneCode("messaging/internal-error")).toBe(false)
    expect(isFcmPruneCode("messaging/server-unavailable")).toBe(false)
    expect(isFcmPruneCode("messaging/quota-exceeded")).toBe(false)
    expect(isFcmPruneCode("messaging/third-party-auth-error")).toBe(false)
    expect(isFcmPruneCode("")).toBe(false)
  })
})

describe("classifyWebPushError", () => {
  it("prunes on 404/410 from the push service", () => {
    expect(classifyWebPushError({ statusCode: 404 })).toEqual({ prune: true, statusCode: 404 })
    expect(classifyWebPushError({ statusCode: 410 })).toEqual({ prune: true, statusCode: 410 })
  })

  it("warns on transient statuses and on errors with no status at all", () => {
    expect(classifyWebPushError({ statusCode: 429 })).toEqual({ prune: false, statusCode: 429 })
    expect(classifyWebPushError({ statusCode: 500 })).toEqual({ prune: false, statusCode: 500 })
    expect(classifyWebPushError(new Error("socket hang up"))).toEqual({
      prune: false,
      statusCode: undefined,
    })
  })

  it("survives a non-object throw (never crashes the send loop)", () => {
    expect(classifyWebPushError(null)).toEqual({ prune: false, statusCode: undefined })
    expect(classifyWebPushError(undefined)).toEqual({ prune: false, statusCode: undefined })
    expect(classifyWebPushError("410")).toEqual({ prune: false, statusCode: undefined })
    expect(classifyWebPushError({ statusCode: "410" })).toEqual({
      prune: false,
      statusCode: undefined,
    })
  })
})

describe("collectExpoInvalidTokens", () => {
  it("returns only DeviceNotRegistered tokens, index-aligned with the chunk", () => {
    const { logger, warns } = recordingLogger()
    const invalid = collectExpoInvalidTokens(
      [
        { status: "ok" },
        { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
        { status: "error", message: "slow down", details: { error: "MessageRateExceeded" } },
      ],
      ["good", "dead", "rate"],
      logger,
    )
    expect(invalid).toEqual(["dead"])
    // The non-prune ticket error is still surfaced.
    expect(warns).toHaveLength(1)
  })

  it("ignores a ticket with no matching token and an error with no details", () => {
    const { logger, warns } = recordingLogger()
    const invalid = collectExpoInvalidTokens(
      [{ status: "error", details: { error: "DeviceNotRegistered" } }, { status: "error" }],
      [],
      logger,
    )
    expect(invalid).toEqual([])
    expect(warns).toHaveLength(2)
  })

  it("is a no-op for an all-ok / empty ticket list", () => {
    const { logger, warns } = recordingLogger()
    expect(collectExpoInvalidTokens([], ["a"], logger)).toEqual([])
    expect(collectExpoInvalidTokens([{ status: "ok" }], ["a"], logger)).toEqual([])
    expect(warns).toHaveLength(0)
  })
})

describe("expo dispatcher retry (429/5xx)", () => {
  it("retries a 429 ONCE and uses the retry's tickets", async () => {
    const { logger } = recordingLogger()
    let call = 0
    const fetchImpl = vi.fn(async () => {
      call++
      if (call === 1) return new Response("slow down", { status: 429 })
      return new Response(
        JSON.stringify({ data: [{ status: "error", details: { error: "DeviceNotRegistered" } }] }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const dispatch = makeExpoDispatcher({ fetchImpl, retryDelayMs: 1 }, logger)
    const { invalidTokens } = await dispatch(["ExponentPushToken[a]"], { title: "Hi" })

    expect(call).toBe(2)
    expect(invalidTokens).toEqual(["ExponentPushToken[a]"])
  })

  it("gives up after ONE retry (never loops) and reports the status", async () => {
    const { logger, errors } = recordingLogger()
    const fetchImpl = vi.fn(
      async () => new Response("boom", { status: 502 }),
    ) as unknown as typeof fetch

    const dispatch = makeExpoDispatcher({ fetchImpl, retryDelayMs: 1 }, logger)
    await expect(dispatch(["ExponentPushToken[a]"], { title: "Hi" })).resolves.toEqual({
      invalidTokens: [],
    })
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2)
    expect(errors).toHaveLength(1)
  })

  it("does NOT retry a 4xx that is not 429", async () => {
    const { logger } = recordingLogger()
    const fetchImpl = vi.fn(
      async () => new Response("bad", { status: 400 }),
    ) as unknown as typeof fetch

    const dispatch = makeExpoDispatcher({ fetchImpl, retryDelayMs: 1 }, logger)
    await dispatch(["ExponentPushToken[a]"], { title: "Hi" })
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
  })
})
