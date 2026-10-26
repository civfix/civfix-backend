import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Notification, Responses } from "node-apn"
import { makeApnsDispatcher } from "../../src/adapters/push-apns.js"
import type { PushLogger } from "../../src/adapters/push-sender.js"

const sent: { note: Notification; tokens: string | string[] }[] = []
let nextResponse: Responses = { sent: [], failed: [] }

vi.mock("node-apn", async (importActual) => {
  const actual = await importActual<typeof import("node-apn")>()
  class Provider {
    send(note: Notification, tokens: string | string[]): Promise<Responses> {
      sent.push({ note, tokens })
      return Promise.resolve(nextResponse)
    }
    shutdown(): void {}
  }
  return { ...actual, Provider }
})

const APNS = {
  keyId: "KEY",
  teamId: "TEAM",
  privateKey: "unused-by-the-stub",
  bundleId: "org.civfix.app",
  production: false,
}

function recordingLogger(): { logger: PushLogger; warns: unknown[] } {
  const warns: unknown[] = []
  return { logger: { warn: (obj) => warns.push(obj), error: () => {} }, warns }
}

beforeEach(() => {
  sent.length = 0
  nextResponse = { sent: [], failed: [] }
})

describe("makeApnsDispatcher", () => {
  it("sends the alert, sound, data and link on the topic of the bundle id", async () => {
    const dispatch = makeApnsDispatcher(APNS, recordingLogger().logger)
    await dispatch(["tok-1"], {
      title: "New reply",
      body: "Someone answered",
      data: { kind: "reply" },
      link: "/post/1",
    })
    expect(sent).toHaveLength(1)
    const { note, tokens } = sent[0]!
    expect(tokens).toEqual(["tok-1"])
    expect(note.topic).toBe("org.civfix.app")
    expect(JSON.stringify(note)).toBe(
      JSON.stringify({
        kind: "reply",
        link: "/post/1",
        aps: { alert: { title: "New reply", body: "Someone answered" }, sound: "default" },
      }),
    )
  })

  it("sends a title-only alert without a body key", async () => {
    const dispatch = makeApnsDispatcher(APNS, recordingLogger().logger)
    await dispatch(["tok-1"], { title: "Heads up" })
    expect(JSON.stringify(sent[0]!.note)).toBe(
      JSON.stringify({ aps: { alert: { title: "Heads up" }, sound: "default" } }),
    )
  })

  it("returns dead tokens for pruning and logs other failures by hash only", async () => {
    nextResponse = {
      sent: [],
      failed: [
        { device: "dead", status: "410", response: { reason: "Unregistered" } },
        { device: "busy", status: "429", response: { reason: "TooManyRequests" } },
      ],
    }
    const { logger, warns } = recordingLogger()
    const dispatch = makeApnsDispatcher(APNS, logger)
    const result = await dispatch(["dead", "busy"], { title: "t" })
    expect(result.invalidTokens).toEqual(["dead"])
    expect(warns).toHaveLength(1)
    expect(JSON.stringify(warns)).not.toContain("busy")
    expect(warns[0]).toMatchObject({ status: "429", reason: "TooManyRequests" })
  })
})
