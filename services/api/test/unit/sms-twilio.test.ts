import { afterEach, describe, expect, it, vi } from "vitest"
import {
  SMS_SEND_TIMEOUT_MS,
  TwilioSmsSender,
  classifyTwilioError,
} from "../../src/adapters/sms-twilio.js"
import { smsFailureKind } from "../../src/errors/sms-failure.js"

interface Recorded {
  url: string
  init: RequestInit
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function senderWith(respond: (recorded: Recorded) => Response | Promise<Response>): {
  sender: TwilioSmsSender
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const fetchImpl = ((url: string, init: RequestInit) => {
    const recorded = { url, init }
    calls.push(recorded)
    return Promise.resolve(respond(recorded))
  }) as unknown as typeof fetch
  const sender = new TwilioSmsSender({
    accountSid: "AC0123456789",
    authToken: "super-secret-token",
    from: "+15550001111",
    fetchImpl,
  })
  return { sender, calls }
}

describe("TwilioSmsSender", () => {
  it("posts a form-encoded message with basic auth and returns the provider message id", async () => {
    const { sender, calls } = senderWith(() =>
      jsonResponse(201, { sid: "SM123", status: "queued" }),
    )

    await expect(sender.send("+15552223333", "your code is 424242")).resolves.toEqual({
      id: "SM123",
    })

    const call = calls[0]
    expect(call?.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC0123456789/Messages.json")
    expect(call?.init.method).toBe("POST")
    const headers = call?.init.headers as Record<string, string>
    const expected = Buffer.from("AC0123456789:super-secret-token", "utf8").toString("base64")
    expect(headers.authorization).toBe(`Basic ${expected}`)
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded")

    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the adapter posts a string form body
    const form = new URLSearchParams(String(call?.init.body))
    expect(form.get("To")).toBe("+15552223333")
    expect(form.get("From")).toBe("+15550001111")
    expect(form.get("Body")).toBe("your code is 424242")
  })

  it("aborts rather than hanging, and reports the abort as retryable", async () => {
    const { sender, calls } = senderWith(() => jsonResponse(201, { sid: "SM1" }))
    await sender.send("+15552223333", "x")
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
    expect((calls[0]?.init.signal as AbortSignal).aborted).toBe(false)
  })

  it("maps 21610 (recipient replied STOP) to a distinguishable opt-out failure", async () => {
    const { sender } = senderWith(() =>
      jsonResponse(400, { code: 21610, message: "Attempt to send to unsubscribed recipient" }),
    )

    const err = await sender.send("+15552223333", "x").catch((e: unknown) => e)
    expect(smsFailureKind(err)).toBe("opted_out")
    expect(err).toMatchObject({ code: "CONFLICT" })
    expect(String((err as Error).message)).toContain("provider code 21610")
  })

  it("maps 21211 and 21614 (bad destination) to an invalid-number failure", async () => {
    for (const providerCode of [21211, 21614]) {
      const { sender } = senderWith(() =>
        jsonResponse(400, { code: providerCode, message: "invalid To number" }),
      )
      const err = await sender.send("+15550000000", "x").catch((e: unknown) => e)
      expect(smsFailureKind(err)).toBe("invalid_number")
      expect(err).toMatchObject({ code: "VALIDATION" })
    }
  })

  it("classifies 5xx and 429 as retryable, and any other 4xx as permanent", () => {
    expect(smsFailureKind(classifyTwilioError(500, {}))).toBe("temporary")
    expect(smsFailureKind(classifyTwilioError(503, {}))).toBe("temporary")
    expect(smsFailureKind(classifyTwilioError(429, { code: 20429 }))).toBe("temporary")
    expect(smsFailureKind(classifyTwilioError(400, { code: 21606 }))).toBe("permanent")
    expect(smsFailureKind(classifyTwilioError(401, {}))).toBe("permanent")
  })

  it("treats a transport failure as retryable rather than a rejection of the number", async () => {
    const failing = (() => Promise.reject(new Error("socket hang up"))) as unknown as typeof fetch
    const sender = new TwilioSmsSender({
      accountSid: "AC1",
      authToken: "t",
      from: "+15550001111",
      fetchImpl: failing,
    })

    const err = await sender.send("+15552223333", "x").catch((e: unknown) => e)
    expect(smsFailureKind(err)).toBe("temporary")
  })

  it("does not report success when the provider returns 2xx with no message id", async () => {
    const { sender } = senderWith(() => jsonResponse(200, { status: "queued" }))
    const err = await sender.send("+15552223333", "x").catch((e: unknown) => e)
    expect(smsFailureKind(err)).toBe("temporary")
  })

  it("survives an unparseable error body instead of throwing a JSON error", async () => {
    const { sender } = senderWith(
      () => new Response("<html>gateway timeout</html>", { status: 502 }),
    )
    const err = await sender.send("+15552223333", "x").catch((e: unknown) => e)
    expect(smsFailureKind(err)).toBe("temporary")
  })

  it("never puts the auth token in the thrown message", async () => {
    const { sender } = senderWith(() => jsonResponse(401, { code: 20003, message: "Authenticate" }))
    const err = await sender.send("+15552223333", "x").catch((e: unknown) => e)
    expect(String((err as Error).message)).not.toContain("super-secret-token")
  })

  it("never echoes the provider's message, which quotes the destination phone number", async () => {
    const { sender } = senderWith(() =>
      jsonResponse(400, {
        code: 21211,
        message: "The 'To' number +15552223333 is not a valid phone number.",
      }),
    )
    const err = await sender.send("+15552223333", "x").catch((e: unknown) => e)
    expect(String((err as Error).message)).not.toContain("+15552223333")
    expect(String((err as Error).message)).toContain("provider code 21211")
  })

  describe("response body", () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it("keeps the send deadline running while the body is read, and does not retry an accepted send", async () => {
      vi.useFakeTimers()
      const { sender } = senderWith(
        () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 201 }),
      )

      const outcome = sender.send("+15552223333", "x").catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(SMS_SEND_TIMEOUT_MS + 1)

      const settled = await Promise.race([outcome, Promise.resolve("still pending")])
      expect(settled).not.toBe("still pending")
      expect(smsFailureKind(settled)).toBe("permanent")
    })

    it("stops reading an error body without content-length once it passes the size cap", async () => {
      const chunk = new Uint8Array(16 * 1024)
      const maxChunks = 128
      let pulled = 0
      const { sender } = senderWith(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                pulled += 1
                if (pulled > maxChunks) controller.close()
                else controller.enqueue(chunk)
              },
            }),
            { status: 400 },
          ),
      )

      const err = await sender.send("+15552223333", "x").catch((e: unknown) => e)
      expect(smsFailureKind(err)).toBe("permanent")
      expect(pulled).toBeLessThan(maxChunks / 2)
    })
  })
})
