import { FakeMailer, FakePushSender } from "@civfix/shared/fakes"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { makeDrizzleBroadcastRepository } from "../../src/services/host/broadcast-repository.drizzle.js"
import {
  makeBroadcastService,
  type BroadcastConfig,
} from "../../src/services/host/broadcast-service.js"
import {
  CHUNK_STALE_MS,
  makeBroadcastPipeline,
} from "../../src/services/host/broadcast-pipeline.js"
import { makeDrizzleNotificationRepository } from "../../src/services/notification-repository.drizzle.js"
import { makeNotificationService } from "../../src/services/notification-service.js"

const pg = await withPg()

const CONFIG: BroadcastConfig = {
  killSwitch: false,
  perEventPerDay: 3,
  recipientsPerDay: 2000,
  cooldownSec: 900,
  minAccountAgeHours: 24,
  maxRecipients: 5000,
  chunkSize: 2,
  emailConcurrency: 2,
  emailRatePerSec: 1000,
  linkAllowedHosts: [],
  mailFromEvents: "events@civfix.org",
  unsubscribeSigningKey: "unsubscribe-signing-key-for-tests-0123456789",
  webBaseUrl: "https://civfix.org",
  apiBaseUrl: "https://api.civfix.org",
  eventUpdatePerEventPerHour: 3,
}

describe.skipIf(!pg)("broadcast delivery on Postgres (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string, email: string | null): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle, email, email_verified, created_at)
      VALUES (${name}, ${testHandle()}, ${email}, ${email !== null}, now() - interval '30 days')
      RETURNING id`
    return row!.id
  }

  it("delivers each channel once per member and a stale-window re-run sends nothing more", async () => {
    let clockMs = Date.now()
    const clock = (): number => clockMs
    const now = (): Date => new Date(clockMs)

    const hostId = await newUser("Host", null)
    const cleanupId = await seedCleanup(h.sql, {
      organizerUserId: hostId,
      title: "Beach sweep",
      scheduledAt: new Date(clockMs + 7 * 86_400_000),
    })
    async function newMember(name: string, email: string | null): Promise<string> {
      const userId = await newUser(name, email)
      await h.sql`
        INSERT INTO cleanup_registrations (cleanup_id, user_id, status)
        VALUES (${cleanupId}, ${userId}, 'registered')`
      return userId
    }
    const emailOf = new Map<string, string>()
    for (let i = 0; i < 3; i += 1) {
      const email = `member-${testHandle()}@example.test`
      emailOf.set(await newMember(`Member ${i}`, email), email)
    }
    const emailed = [...emailOf.keys()]
    const noEmail = await newMember("No Email", null)
    const memberIds = [...emailed, noEmail]

    const repo = makeDrizzleBroadcastRepository(h.sql)
    const mailer = new FakeMailer()
    const push = new FakePushSender()
    const chunks: number[] = []
    const service = makeBroadcastService({
      repo,
      counters: new InMemoryCounterStore(clock),
      config: CONFIG,
      mailer,
      enqueuePlan: () => Promise.resolve(),
      now,
    })
    const pipeline = makeBroadcastPipeline({
      repo,
      service,
      notifications: makeNotificationService({
        repo: makeDrizzleNotificationRepository(h.sql),
        pushSender: push,
        now,
      }),
      mailer,
      cache: new InMemoryCacheClient(clock),
      config: CONFIG,
      mailDomain: "civfix.org",
      enqueueChunk: (_broadcastId, chunkNo) => {
        chunks.push(chunkNo)
        return Promise.resolve()
      },
      audit: () => Promise.resolve(),
      now,
    })

    const record = await repo.create({
      cleanupId,
      createdBy: hostId,
      kind: "host_broadcast",
      subject: "Still on! Ponchos + Coffee",
      bodyMd: "See you at the meeting point.",
      segment: { kind: "all_registered" },
      channels: ["inapp", "push", "email"],
      chunkSize: CONFIG.chunkSize,
    })
    await repo.transition(record.id, ["draft"], "sending", { startedAt: now() })

    const sentAt = now()
    expect((await pipeline.plan(record.id)).kind).toBe("planned")
    const planned = [...chunks]
    expect(planned.length).toBeGreaterThan(1)
    for (const chunkNo of planned) await pipeline.runChunk(record.id, chunkNo)

    async function notificationsPerMember(): Promise<Map<string, number>> {
      const rows = await h.sql<{ user_id: string; n: number }[]>`
        SELECT user_id, count(*)::int AS n FROM notifications
         WHERE user_id = ANY(${memberIds}::uuid[]) GROUP BY user_id`
      return new Map(rows.map((row) => [row.user_id, row.n]))
    }
    function emailsPerMember(): number[] {
      return emailed.map((userId) => mailer.sent.filter((m) => m.to === emailOf.get(userId)).length)
    }

    const deliveries = await h.sql<
      {
        user_id: string
        channel: string
        status: string
        suppression_reason: string | null
        failure_kind: string | null
        has_provider_id: boolean
        sent_at: Date | null
        attempts: number
      }[]
    >`
      SELECT user_id, channel, status, suppression_reason, failure_kind,
             provider_message_id IS NOT NULL AS has_provider_id, sent_at, attempts
        FROM broadcast_deliveries
       WHERE broadcast_id = ${record.id}`
    expect(deliveries).toHaveLength(memberIds.length * 3)
    for (const delivery of deliveries) {
      const suppressed = delivery.user_id === noEmail && delivery.channel === "email"
      expect(delivery, `${delivery.user_id} ${delivery.channel}`).toEqual({
        user_id: delivery.user_id,
        channel: delivery.channel,
        status: suppressed ? "suppressed" : "sent",
        suppression_reason: suppressed ? "no_contact" : null,
        failure_kind: null,
        has_provider_id: delivery.channel === "email" && !suppressed,
        sent_at: suppressed ? null : sentAt,
        attempts: 1,
      })
    }
    expect((await repo.findById(record.id))?.status).toBe("sent")
    expect(await notificationsPerMember()).toEqual(new Map(memberIds.map((id) => [id, 1])))
    expect(emailsPerMember()).toEqual(emailed.map(() => 1))
    expect(mailer.sent).toHaveLength(emailed.length)
    await vi.waitFor(() => expect(push.sent).toHaveLength(memberIds.length))

    clockMs += CHUNK_STALE_MS + 60_000
    for (const chunkNo of planned) await pipeline.runChunk(record.id, chunkNo)

    expect(await notificationsPerMember()).toEqual(new Map(memberIds.map((id) => [id, 1])))
    expect(mailer.sent).toHaveLength(emailed.length)
    expect(push.sent).toHaveLength(memberIds.length)
    const [after] = await h.sql<{ max_attempts: number }[]>`
      SELECT max(attempts)::int AS max_attempts FROM broadcast_deliveries
       WHERE broadcast_id = ${record.id}`
    expect(after!.max_attempts).toBe(1)
  })
})
