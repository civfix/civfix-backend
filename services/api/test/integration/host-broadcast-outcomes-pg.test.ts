import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeDrizzleBroadcastRepository } from "../../src/services/host/broadcast-repository.drizzle.js"
import type { BroadcastRepository } from "../../src/services/host/broadcast-repository.js"

const pg = await withPg()

describe.skipIf(!pg)("broadcast delivery outcomes (integration)", () => {
  let h: PgHarness
  let repo: BroadcastRepository
  let cleanupId: string

  beforeAll(async () => {
    h = pg as PgHarness
    repo = makeDrizzleBroadcastRepository(h.sql)
    const organizerId = await newUser("Host")
    cleanupId = await seedCleanup(h.sql, {
      organizerUserId: organizerId,
      title: "Park sweep",
      lng: -118.25,
      lat: 34.05,
      scheduledAt: new Date(Date.now() + 7 * 86_400_000),
    })
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id`
    return row!.id
  }

  async function sendingBroadcast(): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO broadcasts (cleanup_id, kind, status, subject, body_md)
      VALUES (${cleanupId}, 'host_broadcast', 'sending', 'Update', 'Bring gloves')
      RETURNING id`
    return row!.id
  }

  it("records a chunk whose first outcome was sent, with its sent time", async () => {
    const broadcastId = await sendingBroadcast()
    const first = await newUser("First")
    const second = await newUser("Second")
    await repo.insertDeliveries([
      {
        broadcastId,
        chunkNo: 0,
        recipientKind: "member",
        userId: first,
        guestId: null,
        channel: "inapp",
      },
      {
        broadcastId,
        chunkNo: 0,
        recipientKind: "member",
        userId: second,
        guestId: null,
        channel: "inapp",
      },
    ])
    const claims = await repo.claimChunk({
      broadcastId,
      chunkNo: 0,
      staleBefore: new Date(Date.now() - 600_000),
      maxAttempts: 3,
      limit: 10,
    })
    expect(claims).toHaveLength(2)
    const sentClaim = claims.find((c) => c.userId === first)!
    const suppressedClaim = claims.find((c) => c.userId === second)!
    const sentAt = new Date("2026-09-23T10:00:00.123Z")

    await repo.applyDeliveryOutcomes([
      { id: sentClaim.id, status: "sent", sentAt },
      { id: suppressedClaim.id, status: "suppressed", suppressionReason: "prefs_off" },
    ])

    const rows = await h.sql<
      { id: string; status: string; sent_at: Date | null; suppression_reason: string | null }[]
    >`
      SELECT id, status, sent_at, suppression_reason FROM broadcast_deliveries
       WHERE broadcast_id = ${broadcastId}`
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(sentClaim.id)).toMatchObject({ status: "sent", suppression_reason: null })
    expect(byId.get(sentClaim.id)!.sent_at?.toISOString()).toBe(sentAt.toISOString())
    expect(byId.get(suppressedClaim.id)).toMatchObject({
      status: "suppressed",
      suppression_reason: "prefs_off",
      sent_at: null,
    })
    const record = await repo.refreshCounts(broadcastId)
    expect(record?.sentCount).toBe(1)
    expect(record?.suppressedCount).toBe(1)
  })

  it("records a chunk where every outcome was sent", async () => {
    const broadcastId = await sendingBroadcast()
    const users = [await newUser("A"), await newUser("B"), await newUser("C")]
    await repo.insertDeliveries(
      users.map((userId) => ({
        broadcastId,
        chunkNo: 0,
        recipientKind: "member" as const,
        userId,
        guestId: null,
        channel: "email" as const,
      })),
    )
    const claims = await repo.claimChunk({
      broadcastId,
      chunkNo: 0,
      staleBefore: new Date(Date.now() - 600_000),
      maxAttempts: 3,
      limit: 10,
    })
    const sentAt = new Date()
    await repo.applyDeliveryOutcomes(
      claims.map((c) => ({
        id: c.id,
        status: "sent" as const,
        sentAt,
        providerMessageId: `m-${c.id}`,
      })),
    )
    const counts = await repo.deliveryCounts(broadcastId)
    expect(counts.sent).toBe(3)
    expect(counts.pending).toBe(0)
  })
})
