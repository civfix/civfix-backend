// GH#215 / D7: what each provider receives for a visible push and for a silent clear. FCM runs against a
// fake firebase-admin/messaging, APNs against a local cleartext HTTP/2 server (node:http2's connect is
// redirected to it), web push through an injected module. No request leaves the process.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as http2 from "node:http2"
import type { ClientHttp2Session, IncomingHttpHeaders } from "node:http2"
import { generateKeyPairSync } from "node:crypto"
import type { AddressInfo } from "node:net"
import type { PushPayload } from "@civfix/seams"
import {
  NOTIFICATION_SECTIONS,
  NotificationCategorySchema,
  decodePushMessageData,
  encodePushMessageData,
  type NotificationCategory,
} from "@civfix/contract"
import type { PushDelivery, PushLogger } from "../../src/adapters/push-sender.js"
import { fakePushDb } from "../helpers/push-db.js"
import { MAP, N1, N2, P } from "../helpers/push-fixtures.js"

type FcmResponse = { success: boolean; error?: { code?: string; message?: string } }

const fcm = vi.hoisted(() => ({
  sendEachCalls: [] as unknown[][],
  sendEachForMulticastCalls: 0,
  respond: null as null | ((messages: unknown[]) => FcmResponse[]),
}))

vi.mock("firebase-admin/app", () => ({
  getApps: () => [],
  initializeApp: () => ({ name: "civfix-push" }),
  cert: (value: unknown) => value,
  deleteApp: () => Promise.resolve(),
}))

vi.mock("firebase-admin/messaging", () => ({
  getMessaging: () => ({
    sendEach: (messages: unknown[]) => {
      fcm.sendEachCalls.push(messages)
      const responses = fcm.respond
        ? fcm.respond(messages)
        : messages.map(() => ({ success: true }))
      return Promise.resolve({ responses })
    },
    sendEachForMulticast: () => {
      fcm.sendEachForMulticastCalls += 1
      return Promise.reject(new Error("sendEachForMulticast is not used"))
    },
  }),
}))

const h2 = vi.hoisted(() => ({ target: "", asked: [] as string[], dialed: [] as string[] }))

vi.mock("node:http2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http2")>()
  const connect = ((authority: string | URL, ...rest: unknown[]) => {
    h2.asked.push(String(authority))
    h2.dialed.push(h2.target)
    return (actual.connect as (...args: unknown[]) => ClientHttp2Session)(h2.target, ...rest)
  }) as typeof actual.connect
  return { ...actual, connect, default: { ...actual, connect } }
})

const { makeFcmDispatcher } = await import("../../src/adapters/push-fcm.js")
const { makeApnsDispatcher } = await import("../../src/adapters/push-apns.js")
const { makeWebPushDispatcher } = await import("../../src/adapters/push-webpush.js")
const { MultiPushSender } = await import("../../src/adapters/push-sender.js")

const BUNDLE_ID = "org.civfix.community"
const T = new Date("2026-10-23T10:00:00.500Z").getTime()

function quietLogger(): { logger: PushLogger; warns: unknown[][] } {
  const warns: unknown[][] = []
  return { logger: { warn: (...args) => warns.push(args), error: () => {} }, warns }
}

function visible(token: string, payload: PushPayload): PushDelivery {
  return { token, message: { kind: "notification", payload } }
}

function clearOf(token: string, ids: string[]): PushDelivery {
  return { token, message: { kind: "clear", target: { ids } } }
}

interface ApnsRequest {
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

let apnsServer: http2.Http2Server
let apnsRequests: ApnsRequest[]
const closers: (() => Promise<void>)[] = []

function apnsDispatcher() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const d = makeApnsDispatcher(
    {
      keyId: "ABC123DEFG",
      teamId: "TEAM123456",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      bundleId: BUNDLE_ID,
      production: true,
    },
    quietLogger().logger,
  )
  closers.push(() => d.close?.() ?? Promise.resolve())
  return d
}

function fcmDispatcher(logger: PushLogger = quietLogger().logger) {
  const d = makeFcmDispatcher({ serviceAccountJson: "{}" }, logger)
  closers.push(() => d.close?.() ?? Promise.resolve())
  return d
}

beforeEach(async () => {
  fcm.sendEachCalls.length = 0
  fcm.sendEachForMulticastCalls = 0
  fcm.respond = null
  apnsRequests = []
  h2.asked.length = 0
  h2.dialed.length = 0
  apnsServer = http2.createServer()
  apnsServer.on("stream", (stream, headers) => {
    stream.on("error", () => {})
    let body = ""
    stream.setEncoding("utf8")
    stream.on("data", (chunk: string) => (body += chunk))
    stream.on("end", () => {
      apnsRequests.push({ headers, body: JSON.parse(body) as Record<string, unknown> })
      stream.respond({ ":status": 200 })
      stream.end()
    })
  })
  await new Promise<void>((resolve) => apnsServer.listen(0, "127.0.0.1", resolve))
  h2.target = `http://127.0.0.1:${(apnsServer.address() as AddressInfo).port}`
})

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  await new Promise<void>((resolve) => apnsServer.close(() => resolve()))
  vi.useRealTimers()
})

function fcmMessages(): Record<string, unknown>[] {
  return fcm.sendEachCalls.flat() as Record<string, unknown>[]
}

describe("MultiPushSender: per-recipient ids on the wire", () => {
  it("T8: each device gets its own recipient's notification id as collapse id or tag", async () => {
    const I1 = "ab".repeat(32)
    const fake = fakePushDb([
      { userId: "u1", platform: "ios", token: I1 },
      { userId: "u1", platform: "android", token: "A1" },
      { userId: "u2", platform: "android", token: "A2" },
    ])
    const sender = new MultiPushSender({
      db: fake.db,
      config: {},
      dispatchers: { ios: apnsDispatcher(), android: fcmDispatcher() },
      logger: quietLogger().logger,
    })

    await sender.sendEach([
      { userId: "u1", payload: P(N1, "reportUpdates") },
      { userId: "u2", payload: P(N2, "reportUpdates") },
    ])

    expect(apnsRequests).toHaveLength(1)
    expect(apnsRequests[0]!.headers[":path"]).toBe(`/3/device/${I1}`)
    expect(apnsRequests[0]!.headers["apns-collapse-id"]).toBe(N1)
    const byToken = new Map(fcmMessages().map((m) => [m.token, m]))
    expect(byToken.size).toBe(2)
    const tagOf = (token: string) =>
      (byToken.get(token)!.android as { notification: { tag?: string } }).notification.tag
    expect(tagOf("A1")).toBe(N1)
    expect(tagOf("A2")).toBe(N2)
    expect(JSON.stringify(apnsRequests[0]!.body)).not.toContain(N2)
    expect(JSON.stringify(byToken.get("A1"))).not.toContain(N2)
    expect(JSON.stringify(byToken.get("A2"))).not.toContain(N1)
  })
})

describe("FCM dispatcher", () => {
  it("T9: 1200 android deliveries go out as sendEach calls of 500, 500 and 200", async () => {
    const deliveries = Array.from({ length: 1200 }, (_, i) => visible(`fcm-${i}`, P(N1, null)))

    await fcmDispatcher()(deliveries)

    expect(fcm.sendEachCalls.map((c) => c.length)).toEqual([500, 500, 200])
    expect(fcm.sendEachForMulticastCalls).toBe(0)
  })

  it("T10: a visible push carries the data map, the tag and the section's channel", async () => {
    await fcmDispatcher()([visible("fcm-a", P(N1, "reportUpdates"))])

    expect(fcmMessages()).toEqual([
      {
        token: "fcm-a",
        notification: { title: "Status changed", body: "Your report is in progress" },
        data: MAP(N1, "reportUpdates"),
        android: { notification: { tag: N1, channelId: "reports" } },
      },
    ])
  })

  it("T11: every category maps to its section's channel id", async () => {
    const expected: Record<string, string> = {
      reportUpdates: "reports",
      reportDiscussions: "reports",
      directMessages: "messages",
      mentions: "messages",
      groupChats: "messages",
      events: "events",
      hostAnnouncements: "events",
      eventTeam: "events",
      followers: "social",
      likesAndReposts: "social",
      organizations: "organizations",
    }
    const categories = Object.keys(expected) as NotificationCategory[]
    expect(categories).toHaveLength(11)

    await fcmDispatcher()(categories.map((c) => visible(`fcm-${c}`, P(N1, c))))

    for (const message of fcmMessages()) {
      const category = String(message.token).slice("fcm-".length)
      const channel = (message.android as { notification: { channelId: string } }).notification
        .channelId
      expect(channel, category).toBe(expected[category])
    }
    expect(fcmMessages()).toHaveLength(11)
  })

  it("T13: invalid-argument prunes a token only when another message in the same call succeeded", async () => {
    const invalidArgument: FcmResponse = {
      success: false,
      error: { code: "messaging/invalid-argument", message: "bad" },
    }

    fcm.respond = () => [{ success: true }, invalidArgument]
    const mixed = await fcmDispatcher()([visible("good", P(N1, null)), visible("bad", P(N2, null))])
    expect(mixed.invalidTokens).toEqual(["bad"])

    fcm.respond = () => [invalidArgument, invalidArgument]
    const { logger, warns } = quietLogger()
    const rejected = await fcmDispatcher(logger)([
      visible("one", P(N1, null)),
      visible("two", P(N2, null)),
    ])
    expect(rejected.invalidTokens).toEqual([])
    expect(warns).toHaveLength(1)
  })

  it("T22: a silent clear is data-only with normal priority", async () => {
    await fcmDispatcher()([clearOf("fcm-a", [N1, N2])])

    expect(fcmMessages()).toEqual([
      {
        token: "fcm-a",
        data: { kind: "clear", ids: JSON.stringify([N1, N2]) },
        android: { priority: "normal" },
      },
    ])
  })
})

describe("APNs dispatcher", () => {
  it("T14: a visible push is an alert with collapse id, thread id and the data map under body", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(T)
    const I1 = "ab".repeat(32)

    await apnsDispatcher()([visible(I1, P(N1, "reportUpdates"))])

    expect(apnsRequests).toHaveLength(1)
    const { headers, body } = apnsRequests[0]!
    expect(headers["apns-push-type"]).toBe("alert")
    expect(headers["apns-priority"]).toBe("10")
    expect(headers["apns-expiration"]).toBe(String(Math.floor(T / 1000) + 86400))
    expect(headers["apns-collapse-id"]).toBe(N1)
    expect(headers["apns-topic"]).toBe(BUNDLE_ID)
    expect(body).toEqual({
      aps: {
        alert: { title: "Status changed", body: "Your report is in progress" },
        sound: "default",
        "thread-id": "reportUpdates",
      },
      body: MAP(N1, "reportUpdates"),
    })
  })

  it("T21: a silent clear is a background push at priority 5 with only content-available", async () => {
    await apnsDispatcher()([clearOf("ab".repeat(32), [N1, N2])])

    const { headers, body } = apnsRequests[0]!
    expect(headers["apns-push-type"]).toBe("background")
    expect(headers["apns-priority"]).toBe("5")
    expect(headers["apns-collapse-id"]).toBeUndefined()
    expect(body).toEqual({
      aps: { "content-available": 1 },
      body: { kind: "clear", ids: JSON.stringify([N1, N2]) },
    })
  })
})

describe("web push dispatcher", () => {
  it("T16: the body is { title, body, link, tag, data } with a day's TTL and normal urgency", async () => {
    const sent: { body: string; options: Record<string, unknown> }[] = []
    const dispatch = makeWebPushDispatcher(
      {
        publicKey: "pub",
        privateKey: "priv",
        subject: "mailto:ops@civfix.test",
        resolveAddresses: () => Promise.resolve(["93.184.216.34"]),
        loadModule: () =>
          Promise.resolve({
            setVapidDetails: () => {},
            sendNotification: (_sub: unknown, body: string, options: Record<string, unknown>) => {
              sent.push({ body, options })
              return Promise.resolve({ statusCode: 201 })
            },
          }),
      },
      quietLogger().logger,
    )
    closers.push(() => dispatch.close?.() ?? Promise.resolve())
    const subscription = JSON.stringify({
      endpoint: "https://push.example.test/sub/1",
      keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
    })

    const result = await dispatch([
      { token: subscription, message: { kind: "notification", payload: P(N1, "reportUpdates") } },
    ])

    expect(result.invalidTokens).toEqual([])
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0]!.body)).toEqual({
      title: "Status changed",
      body: "Your report is in progress",
      link: "/reports/r1",
      tag: N1,
      data: MAP(N1, "reportUpdates"),
    })
    expect(sent[0]!.options).toMatchObject({ TTL: 86400, urgency: "normal" })
  })
})

describe("no provider is reached", () => {
  it("T28: APNs dials only the local server, FCM only the fake module, web push only the injected one", async () => {
    let webModuleLoads = 0
    const web = makeWebPushDispatcher(
      {
        publicKey: "pub",
        privateKey: "priv",
        subject: "mailto:ops@civfix.test",
        resolveAddresses: () => Promise.resolve(["93.184.216.34"]),
        loadModule: () => {
          webModuleLoads += 1
          return Promise.resolve({
            setVapidDetails: () => {},
            sendNotification: () => Promise.resolve({ statusCode: 201 }),
          })
        },
      },
      quietLogger().logger,
    )
    closers.push(() => web.close?.() ?? Promise.resolve())
    const subscription = JSON.stringify({
      endpoint: "https://push.example.test/sub/1",
      keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
    })

    await apnsDispatcher()([visible("ab".repeat(32), P(N1, null)), clearOf("cd".repeat(32), [N1])])
    await fcmDispatcher()([visible("fcm-a", P(N1, null)), clearOf("fcm-b", [N1])])
    await web([{ token: subscription, message: { kind: "notification", payload: P(N1, null) } }])

    expect(h2.asked).toEqual(["https://api.push.apple.com:443"])
    expect(h2.dialed).toEqual([h2.target])
    expect(h2.target).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(apnsRequests).toHaveLength(2)
    expect(fcmMessages()).toHaveLength(2)
    expect(webModuleLoads).toBe(1)
  })
})

// GH#221: the dispatchers build PushMessageData from the payload and encode it with the contract's codec,
// so the app decodes exactly what the backend sent.
describe("GH#221: the contract's push codec on the wire", () => {
  const notificationData = (category: PushPayload["category"]) =>
    ({
      kind: "notification",
      notificationId: N1,
      type: "report_update",
      category,
      link: "/reports/r1",
    }) as const

  function webDispatcher(sent: string[]) {
    const d = makeWebPushDispatcher(
      {
        publicKey: "pub",
        privateKey: "priv",
        subject: "mailto:ops@civfix.test",
        resolveAddresses: () => Promise.resolve(["93.184.216.34"]),
        loadModule: () =>
          Promise.resolve({
            setVapidDetails: () => {},
            sendNotification: (_sub: unknown, body: string) => {
              sent.push(body)
              return Promise.resolve({ statusCode: 201 })
            },
          }),
      },
      quietLogger().logger,
    )
    closers.push(() => d.close?.() ?? Promise.resolve())
    return d
  }

  const subscription = JSON.stringify({
    endpoint: "https://push.example.test/sub/1",
    keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
  })

  it("T27: FCM data is encodePushMessageData's map, decodable back, on the section's channel", async () => {
    await fcmDispatcher()([visible("fcm-a", P(N1, "likesAndReposts"))])

    const [message] = fcmMessages()
    const expected = notificationData("likesAndReposts")
    expect(message!.data).toEqual(encodePushMessageData(expected))
    expect(decodePushMessageData(message!.data)).toEqual(expected)
    expect(message!.android).toEqual({ notification: { tag: N1, channelId: "social" } })
  })

  it("T28: each category's channel is the id of the NOTIFICATION_SECTIONS entry listing it", async () => {
    const categories = NotificationCategorySchema.options
    expect(categories).toHaveLength(11)

    await fcmDispatcher()(categories.map((c) => visible(`fcm-${c}`, P(N1, c))))

    const messages = fcmMessages()
    expect(messages).toHaveLength(11)
    for (const message of messages) {
      const category = String(message.token).slice("fcm-".length)
      const section = NOTIFICATION_SECTIONS.find((s) =>
        (s.categories as readonly string[]).includes(category),
      )
      const channel = (message.android as { notification: { channelId: string } }).notification
        .channelId
      expect(channel, category).toBe(section!.id)
    }
  })

  it("T29: an Always on push with no link gets the default channel and only kind, id and type", async () => {
    await fcmDispatcher()([
      visible("fcm-a", { title: "Hi", notificationId: N1, type: "system", category: null }),
    ])

    const [message] = fcmMessages()
    expect(message!.android).toEqual({ notification: { tag: N1, channelId: "default" } })
    expect(message!.data).toEqual({ kind: "notification", notificationId: N1, type: "system" })
  })

  it("T30: APNs carries the encoded map under body, the category as thread id, the id as collapse id", async () => {
    const dispatch = apnsDispatcher()
    await dispatch([visible("ab".repeat(32), P(N1, "events"))])
    await dispatch([visible("ab".repeat(32), P(N1, null))])

    expect(apnsRequests).toHaveLength(2)
    const [first, second] = apnsRequests
    expect(first!.body.body).toEqual(encodePushMessageData(notificationData("events")))
    expect((first!.body.aps as Record<string, unknown>)["thread-id"]).toBe("events")
    expect(first!.headers["apns-collapse-id"]).toBe(N1)
    expect(second!.body.aps).not.toHaveProperty("thread-id")
    expect(second!.headers["apns-collapse-id"]).toBe(N1)
    expect(second!.body.body).not.toHaveProperty("category")
  })

  it("T31: web push data is the encoded map, tagged with the notification id", async () => {
    const sent: string[] = []
    await webDispatcher(sent)([
      { token: subscription, message: { kind: "notification", payload: P(N1, "followers") } },
    ])

    expect(sent).toHaveLength(1)
    const body = JSON.parse(sent[0]!) as Record<string, unknown>
    expect(body.data).toEqual(encodePushMessageData(notificationData("followers")))
    expect(body.tag).toBe(N1)
  })

  it("T32: clears on FCM and APNs carry encodePushMessageData's clear map", async () => {
    const fcmD = fcmDispatcher()
    const apnsD = apnsDispatcher()
    const ids: PushDelivery["message"] = { kind: "clear", target: { ids: [N1, N2] } }
    const all: PushDelivery["message"] = { kind: "clear", target: { all: true } }

    await fcmD([{ token: "fcm-a", message: ids }])
    await fcmD([{ token: "fcm-a", message: all }])
    await apnsD([{ token: "ab".repeat(32), message: ids }])
    await apnsD([{ token: "ab".repeat(32), message: all }])

    const idsMap = encodePushMessageData({ kind: "clear", ids: [N1, N2] })
    const allMap = encodePushMessageData({ kind: "clear", all: true })
    expect(idsMap).toEqual({ kind: "clear", ids: JSON.stringify([N1, N2]) })
    expect(allMap).toEqual({ kind: "clear", all: "true" })
    expect(fcmMessages().map((m) => m.data)).toEqual([idsMap, allMap])
    expect(apnsRequests.map((r) => r.body.body)).toEqual([idsMap, allMap])
  })
})
