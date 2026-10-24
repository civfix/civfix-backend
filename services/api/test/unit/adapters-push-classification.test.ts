// Prune-vs-warn is expensive to get wrong both ways: pruning on a transient failure silently stops push
// to a live device, and missing a dead token keeps it in push_tokens with every send re-attempting it.

import { describe, it, expect } from "vitest"
import { isApnsPruneFailure } from "../../src/adapters/push-apns.js"
import { isFcmPruneCode } from "../../src/adapters/push-fcm.js"
import { classifyWebPushError } from "../../src/adapters/push-webpush.js"

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
