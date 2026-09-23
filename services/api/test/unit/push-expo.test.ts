import { describe, it, expect, vi } from "vitest"
import { makeExpoDispatcher, isExpoPushToken } from "../../src/adapters/push-expo.js"
import type { PushLogger } from "../../src/adapters/push-sender.js"
import type { PushPayload } from "@civfix/shared/interfaces"

const logger: PushLogger = { warn: () => {}, error: () => {} }
const PAYLOAD: PushPayload = { title: "Hi", body: "there", link: "/x", data: { k: "v" } }

function jsonFetch(body: unknown): {
  fetchImpl: typeof fetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe("isExpoPushToken", () => {
  it("matches Expo token formats and rejects raw / web-subscription tokens", () => {
    expect(isExpoPushToken("ExponentPushToken[abc]")).toBe(true)
    expect(isExpoPushToken("ExpoPushToken[abc]")).toBe(true)
    expect(isExpoPushToken("0123abcdef4567")).toBe(false)
    expect(isExpoPushToken('{"endpoint":"https://fcm.example/x"}')).toBe(false)
  })
})

describe("makeExpoDispatcher", () => {
  it("POSTs expo messages with title/body/data (link merged) + auth header; no invalid on all-ok", async () => {
    const { fetchImpl, calls } = jsonFetch({ data: [{ status: "ok", id: "r1" }] })
    const dispatch = makeExpoDispatcher({ fetchImpl, accessToken: "secret" }, logger)

    const { invalidTokens } = await dispatch(["ExponentPushToken[a]"], PAYLOAD)

    expect(invalidTokens).toEqual([])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain("exp.host")
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe("Bearer secret")
    const msg = (JSON.parse(calls[0]!.init.body as string) as Array<Record<string, unknown>>)[0]!
    expect(msg.to).toBe("ExponentPushToken[a]")
    expect(msg.title).toBe("Hi")
    expect(msg.body).toBe("there")
    expect(msg.sound).toBe("default")
    expect(msg.data).toEqual({ k: "v", link: "/x" })
  })

  it("omits the auth header when no access token is configured", async () => {
    const { fetchImpl, calls } = jsonFetch({ data: [{ status: "ok" }] })
    const dispatch = makeExpoDispatcher({ fetchImpl }, logger)
    await dispatch(["ExponentPushToken[a]"], PAYLOAD)
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
  })

  it("returns DeviceNotRegistered tokens as invalid (index-aligned), ignoring other ticket errors", async () => {
    const { fetchImpl } = jsonFetch({
      data: [
        { status: "ok", id: "r1" },
        { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
        { status: "error", message: "rate", details: { error: "MessageRateExceeded" } },
      ],
    })
    const dispatch = makeExpoDispatcher({ fetchImpl }, logger)
    const { invalidTokens } = await dispatch(
      ["ExponentPushToken[good]", "ExponentPushToken[bad]", "ExponentPushToken[rate]"],
      PAYLOAD,
    )
    expect(invalidTokens).toEqual(["ExponentPushToken[bad]"])
  })

  it("degrades to a no-op (never throws) on a network error or non-OK HTTP status", async () => {
    const throwing = vi.fn(async () => {
      throw new Error("network")
    }) as unknown as typeof fetch
    await expect(
      makeExpoDispatcher({ fetchImpl: throwing }, logger)(["ExponentPushToken[a]"], PAYLOAD),
    ).resolves.toEqual({ invalidTokens: [] })

    const http500 = vi.fn(
      async () => new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch
    await expect(
      makeExpoDispatcher({ fetchImpl: http500 }, logger)(["ExponentPushToken[a]"], PAYLOAD),
    ).resolves.toEqual({ invalidTokens: [] })
  })

  it("passes an AbortSignal to fetch (per-chunk timeout wiring)", async () => {
    let init: RequestInit | undefined
    const fetchImpl = vi.fn(async (_url: string, i: RequestInit) => {
      init = i
      return new Response(JSON.stringify({ data: [{ status: "ok" }] }), { status: 200 })
    }) as unknown as typeof fetch
    const dispatch = makeExpoDispatcher({ fetchImpl }, logger)
    await dispatch(["ExponentPushToken[a]"], PAYLOAD)
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it("chunks more than 100 tokens into multiple requests", async () => {
    const { fetchImpl } = jsonFetch({ data: [] })
    const dispatch = makeExpoDispatcher({ fetchImpl }, logger)
    const tokens = Array.from({ length: 150 }, (_, i) => `ExponentPushToken[${i}]`)
    await dispatch(tokens, PAYLOAD)
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2)
  })
})
