import { describe, it, expect } from "vitest"
import { makeDmAckMarkRead } from "../../src/routes/chat-gateway-wiring.js"

const THREAD = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const USER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
const KNOWN = "cccccccc-cccc-cccc-cccc-cccccccccccc"
const UNKNOWN = "dddddddd-dddd-dddd-dddd-dddddddddddd"
const KNOWN_AT = new Date("2026-09-01T12:00:00.000Z")

function harness(): {
  markRead: ReturnType<typeof makeDmAckMarkRead>
  watermarks: Date[]
  cleared: string[]
} {
  const watermarks: Date[] = []
  const cleared: string[] = []
  const markRead = makeDmAckMarkRead(
    {
      resolveMessageCreatedAt: (_threadId, messageId) =>
        Promise.resolve(messageId === KNOWN ? KNOWN_AT : null),
      markRead: (_threadId, _userId, at) => {
        watermarks.push(at)
        return Promise.resolve()
      },
    },
    (threadId) => {
      cleared.push(threadId)
      return Promise.resolve()
    },
  )
  return { markRead, watermarks, cleared }
}

describe("DM ack over the socket", () => {
  it("advances the read watermark to the acked message's own timestamp", async () => {
    const h = harness()

    await h.markRead(THREAD, USER, KNOWN)

    expect(h.watermarks).toEqual([KNOWN_AT])
    expect(h.cleared).toEqual([THREAD])
  })

  it("does not mark the thread read when the acked message does not resolve in it", async () => {
    const h = harness()

    await h.markRead(THREAD, USER, UNKNOWN)

    expect(h.watermarks).toEqual([])
  })
})
