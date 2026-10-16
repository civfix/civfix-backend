import { describe, it, expect } from "vitest"
import {
  FakeStorage,
  FakeMailer,
  FakeGeocoder,
  FakeInboundMail,
  FakeChatService,
  FakeUserChannel,
  FakePushSender,
  FakeRoutingProvider,
  FakeAbuseChecks,
  FakeJobs,
} from "../src/fakes/index.js"
import type {
  Storage,
  Mailer,
  Geocoder,
  InboundMail,
  ChatService,
  PushSender,
  RoutingProvider,
  AbuseChecks,
  Jobs,
  ChatConnection,
} from "../src/interfaces/index.js"

const enc = new TextEncoder()

describe("fakes satisfy their interfaces", () => {
  it("assigns each fake to its interface type", () => {
    const storage: Storage = new FakeStorage()
    const mailer: Mailer = new FakeMailer()
    const geocoder: Geocoder = new FakeGeocoder()
    const inbound: InboundMail = new FakeInboundMail()
    const chat: ChatService = new FakeChatService()
    const push: PushSender = new FakePushSender()
    const routing: RoutingProvider = new FakeRoutingProvider()
    const abuse: AbuseChecks = new FakeAbuseChecks()
    const jobs: Jobs = new FakeJobs()
    expect([storage, mailer, geocoder, inbound, chat, push, routing, abuse, jobs]).toHaveLength(9)
  })
})

describe("FakeStorage", () => {
  it("round-trips put/head/get/delete and presigns a memory url", async () => {
    const s = new FakeStorage()
    const pre = await s.presignPut("k1", { contentType: "image/png", byteSize: 3 })
    expect(pre.url).toBe("memory://k1")

    await s.put("k1", enc.encode("abc"), { contentType: "image/png" })
    const head = await s.head("k1")
    expect(head).toEqual({ size: 3, contentType: "image/png" })
    expect(s.get("k1")).toEqual(enc.encode("abc"))

    await s.delete("k1")
    expect(await s.head("k1")).toBeNull()
  })
})

describe("FakeMailer", () => {
  it("captures OTP sends", async () => {
    const m = new FakeMailer()
    await m.sendOtp("user@example.com", "123456")
    expect(m.sent).toHaveLength(1)
    expect(m.lastOtpFor("user@example.com")).toBe("123456")
  })
})

describe("FakeGeocoder", () => {
  it("returns the LA default and honors overrides", async () => {
    const g = new FakeGeocoder()
    expect(await g.cityStateLabel(34.05, -118.24)).toBe("Los Angeles, CA")
    g.setLabel(40.7128, -74.006, "New York, NY")
    expect(await g.cityStateLabel(40.7128, -74.006)).toBe("New York, NY")
  })
})

describe("FakeInboundMail", () => {
  it("parses headers/body and extracts a thread token", async () => {
    const m = new FakeInboundMail()
    const raw = enc.encode(
      "From: Gov <gov@lacity.gov>\nTo: reply+0123456789abcdef01234567@civfix.org\nSubject: Re: pin\n\nLooks fixed.",
    )
    const parsed = await m.parse(raw)
    expect(parsed.from?.address).toBe("gov@lacity.gov")
    expect(parsed.subject).toBe("Re: pin")
    expect(parsed.text).toBe("Looks fixed.")
    expect(m.extractThreadToken(parsed)).toBe("0123456789abcdef01234567")
  })

  it("extracts a token from the current report-/event- reply addresses", async () => {
    const m = new FakeInboundMail()
    const reportReply = await m.parse(
      enc.encode("To: report-k7m2x9q4ab3d@civfix.org\n\nthanks"),
    )
    expect(m.extractThreadToken(reportReply)).toBe("k7m2x9q4ab3d")
    const eventReply = await m.parse(enc.encode("To: event-k7m2x9q4ab3d@civfix.org\n\nok"))
    expect(m.extractThreadToken(eventReply)).toBe("k7m2x9q4ab3d")
  })

  it("ignores a typed prefix on a FOREIGN domain (no thread-token false positive)", async () => {
    const m = new FakeInboundMail()
    const foreign = await m.parse(enc.encode("To: report-publicworks@city.gov\n\nhi"))
    expect(m.extractThreadToken(foreign)).toBeNull()
    const decoy = await m.parse(enc.encode("To: event-registration@constantcontact.com\n\nhi"))
    expect(m.extractThreadToken(decoy)).toBeNull()
  })
})

describe("FakeInboundMail thread token parity with the real adapter", () => {
  it("ignores a spoofable X-Thread-Token header", async () => {
    const m = new FakeInboundMail()
    const mail = await m.parse(
      enc.encode("To: clerk@lacity.gov\nX-Thread-Token: abcdefgh1234\n\nhi"),
    )
    expect(m.extractThreadToken(mail)).toBeNull()
  })

  it("finds a reply address in Cc when To is the city clerk", async () => {
    const m = new FakeInboundMail()
    const mail = await m.parse(
      enc.encode(
        'To: clerk@lacity.gov\nCc: "Ops" <ops@lacity.gov>, report-k7m2x9q4ab3d@civfix.org\n\nhi',
      ),
    )
    expect(m.extractThreadToken(mail)).toBe("k7m2x9q4ab3d")
  })

  it("lowercases the address before matching, like the real adapter", async () => {
    const m = new FakeInboundMail()
    const mail = await m.parse(enc.encode("To: Report-K7M2X9Q4AB3D@CivFix.org\n\nhi"))
    expect(m.extractThreadToken(mail)).toBe("k7m2x9q4ab3d")
  })
})

describe("FakeChatService", () => {
  it("broadcast reaches a joined connection and history paginates", async () => {
    const chat = new FakeChatService()
    const received: string[] = []
    const conn: ChatConnection = { id: "c1", send: (d) => received.push(d) }

    await chat.joinRoom("cleanup-1", conn, "user-1")
    expect(chat.roomSize("cleanup-1")).toBe(1)

    const msg = await chat.persist({ cleanupId: "cleanup-1", userId: "user-1", body: "hello" })
    await chat.broadcast("cleanup-1", msg)
    expect(received).toHaveLength(1)
    expect(JSON.parse(received[0]!)).toMatchObject({ message: { body: "hello" } })

    await chat.persist({ cleanupId: "cleanup-1", userId: "user-1", body: "second" })
    const page = await chat.history("cleanup-1", undefined, 1)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.body).toBe("second") // newest first
    expect(page.nextCursor).not.toBeNull()

    await chat.leaveRoom("cleanup-1", conn)
    expect(chat.roomSize("cleanup-1")).toBe(0)
  })
})

describe("FakeChatService clock", () => {
  it("stamps createdAt from the injected clock", async () => {
    const at = Date.parse("2026-05-16T16:00:00.000Z")
    const chat = new FakeChatService(() => at)
    const msg = await chat.persist({ cleanupId: "cleanup-1", userId: "user-1", body: "hello" })
    expect(msg.createdAt).toBe("2026-05-16T16:00:00.000Z")
  })
})

describe("FakeUserChannel", () => {
  it("delivers a signal frame only to the targeted user's connections and captures the publish", async () => {
    const ch = new FakeUserChannel()
    const a: string[] = []
    const b: string[] = []
    const connA: ChatConnection = { id: "a1", send: (d) => a.push(d) }
    const connB: ChatConnection = { id: "b1", send: (d) => b.push(d) }

    await ch.subscribeUser("user-a", connA)
    await ch.subscribeUser("user-b", connB)
    expect(ch.subscriberCount("user-a")).toBe(1)

    await ch.publishToUser("user-a", { topic: "notifications" })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(0)
    expect(JSON.parse(a[0]!)).toEqual({ type: "signal", topic: "notifications" })
    expect(ch.published).toEqual([{ userId: "user-a", signal: { topic: "notifications" } }])
  })

  it("unsubscribe stops further delivery", async () => {
    const ch = new FakeUserChannel()
    const received: string[] = []
    const conn: ChatConnection = { id: "c1", send: (d) => received.push(d) }

    const unsubscribe = await ch.subscribeUser("user-a", conn)
    await ch.publishToUser("user-a", { topic: "reports" })
    expect(received).toHaveLength(1)

    await unsubscribe()
    expect(ch.subscriberCount("user-a")).toBe(0)
    await ch.publishToUser("user-a", { topic: "reports" })
    expect(received).toHaveLength(1) // no new frame after unsubscribe
  })

  it("publishToUsers fans to every listed user and reset() clears state", async () => {
    const ch = new FakeUserChannel()
    const a: string[] = []
    const b: string[] = []
    await ch.subscribeUser("user-a", { id: "a1", send: (d) => a.push(d) })
    await ch.subscribeUser("user-b", { id: "b1", send: (d) => b.push(d) })

    await ch.publishToUsers(["user-a", "user-b"], { topic: "threads", id: "00000000-0000-0000-0000-000000000000" })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(ch.published).toHaveLength(2)

    ch.reset()
    expect(ch.published).toHaveLength(0)
    expect(ch.subscriberCount("user-a")).toBe(0)
  })
})

describe("FakePushSender", () => {
  it("captures registrations and sends", async () => {
    const p = new FakePushSender()
    await p.registerToken("u1", "tok", "ios", "dev-1")
    await p.send("u1", { title: "Hi" })
    await p.sendMany(["u2", "u3"], { title: "Bulk" })
    expect(p.tokens).toHaveLength(1)
    expect(p.sent).toHaveLength(3)
  })
})

describe("FakeRoutingProvider", () => {
  it("returns a square matrix and keeps stop order", async () => {
    const r = new FakeRoutingProvider()
    const pts = [
      { lat: 34.0, lng: -118.0 },
      { lat: 34.01, lng: -118.01 },
    ]
    const m = await r.matrix(pts)
    expect(m).toHaveLength(2)
    expect(m[0]).toHaveLength(2)
    expect(m[0]![0]).toBe(0)

    const route = await r.optimize(
      [
        { id: "a", point: pts[0]! },
        { id: "b", point: pts[1]! },
      ],
      {},
    )
    expect(route.order).toEqual([0, 1])
    expect(route.legs).toHaveLength(1)
    expect(route.totalDistanceMeters).toBeGreaterThan(0)
  })
})

describe("FakeAbuseChecks", () => {
  it("verifyTurnstile is false only for the 'fail' token", async () => {
    const a = new FakeAbuseChecks()
    expect(await a.verifyTurnstile("ok", "1.2.3.4")).toBe(true)
    expect(await a.verifyTurnstile("fail", "1.2.3.4")).toBe(false)
  })

  it("pHash is deterministic and near-dup tracks repeats", async () => {
    const a = new FakeAbuseChecks()
    const h1 = await a.pHash(enc.encode("same"))
    const h2 = await a.pHash(enc.encode("same"))
    expect(h1).toBe(h2)
    expect((await a.isNearDuplicate(h1)).dup).toBe(false)
    expect((await a.isNearDuplicate(h1)).dup).toBe(true)
  })

  it("nsfwScore flags the marker", async () => {
    const a = new FakeAbuseChecks()
    expect(await a.nsfwScore(enc.encode("hello"))).toBe(0)
    expect(await a.nsfwScore(enc.encode("xxNSFWxx"))).toBe(1)
  })

  it("gpsPlausible: true when near, false when far apart", async () => {
    const a = new FakeAbuseChecks()
    const la = { lat: 34.05, lng: -118.24 }
    const near = { lat: 34.06, lng: -118.25 }
    const ny = { lat: 40.71, lng: -74.0 }
    expect(await a.gpsPlausible(la, near)).toBe(true)
    expect(await a.gpsPlausible(la, ny)).toBe(false)
    expect(await a.gpsPlausible(la, null, ny)).toBe(false)
  })
})

describe("FakeJobs", () => {
  it("runs a registered handler synchronously on enqueue", async () => {
    const jobs = new FakeJobs()
    const seen: unknown[] = []
    await jobs.work("send-email", async (job) => {
      seen.push(job.data)
    })
    const id = await jobs.enqueue("send-email", { to: "a@b.com" })
    expect(seen).toEqual([{ to: "a@b.com" }])
    expect(jobs.jobsFor("send-email")[0]!.state).toBe("completed")
    expect(typeof id).toBe("string")
  })

  it("records schedules without firing them", async () => {
    const jobs = new FakeJobs()
    await jobs.schedule("nightly", "0 0 * * *", { task: "rollup" })
    expect(jobs.scheduled).toHaveLength(1)
    expect(jobs.scheduled[0]!.cron).toBe("0 0 * * *")
  })

  it("marks a job failed when its handler throws", async () => {
    const jobs = new FakeJobs()
    await jobs.work("boom", async () => {
      throw new Error("nope")
    })
    await jobs.enqueue("boom", {})
    expect(jobs.jobsFor("boom")[0]!.state).toBe("failed")
  })
})
