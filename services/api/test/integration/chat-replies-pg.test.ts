/**
 * Reply threading integration test (P2 Task 2.3, Docker-gated). Boots against a live PostGIS container
 * (via withPg) and exercises the DB-backed reply persist/validation/hydration paths:
 *
 *   - persist accepts replyToId and the returned DTO + a later history read both carry the hydrated
 *     replyTo preview ({from, excerpt, kind}) resolved from the SAME table;
 *   - persist-time validation: a target in a DIFFERENT room -> 422 AppError fields.code
 *     "reply_wrong_room"; a tombstoned target -> 422 "reply_deleted_target";
 *   - deleting the ORIGINAL after the reply landed re-hydrates history with replyTo.deleted:true and an
 *     EMPTY excerpt (the original text must not survive its deletion via the preview);
 *   - the DM twin (dm_messages / thread_id scope) round-trips the same way;
 *   - excerpt truncation at REPLY_EXCERPT_MAX (120) chars.
 *
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI runs it for real.
 */

import { TEST_TICKET_SIGNER } from "../helpers/ticket-signer.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { AppError } from "@civfix/shared"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { makeDrizzleChatRepository } from "../../src/services/chat-repository.drizzle.js"
import { makeDrizzleDmRepository } from "../../src/services/dm-repository.drizzle.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { makeCleanupService } from "../../src/services/cleanup-service.js"
import { REPLY_EXCERPT_MAX } from "../../src/services/chat-reply-hydration.js"

const pg = await withPg()

/** Await a rejection and assert it is the expected 422 reply AppError. */
async function expectReplyError(p: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown
  try {
    await p
  } catch (err) {
    caught = err
  }
  expect(caught, `expected a rejection with fields.code=${code}`).toBeInstanceOf(AppError)
  const app = caught as AppError
  expect(app.httpStatus).toBe(422)
  expect(app.fields?.code).toBe(code)
}

describe.skipIf(!pg)("chat replies (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  /** Insert a user and return its id. */
  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${testHandle()}) RETURNING id
    `
    return u!.id
  }

  /** Create a cleanup (organizer joined) and return its id. */
  async function newCleanup(organizerId: string, title: string): Promise<string> {
    const created = await makeCleanupService({
      tickets: TEST_TICKET_SIGNER,
      repo: makeDrizzleCleanupRepository(h.sql),
    }).createCleanup(
      {
        title,
        type: "site",
        eventKind: "cleanup",
        lat: 34.05,
        lng: -118.25,
        scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        slots: [{ title: "General volunteers", capacity: null }],
      },
      organizerId,
    )
    return created.id
  }

  it("cleanup reply round-trip: persist carries hydrated replyTo, and so does history", async () => {
    const organizerId = await newUser("Reply Org")
    const cleanupId = await newCleanup(organizerId, "Reply sweep")
    const repo = makeDrizzleChatRepository(h.sql)

    const original = await repo.insertMessage(
      { cleanupId, userId: organizerId, body: "original message" },
      randomUUID(),
    )
    const reply = await repo.insertMessage(
      { cleanupId, userId: organizerId, body: "a reply", replyToId: original.id },
      randomUUID(),
    )

    // The persisted (ack/broadcast) DTO is hydrated without a re-read.
    expect(reply.replyToId).toBe(original.id)
    expect(reply.replyTo).toMatchObject({
      id: original.id,
      excerpt: "original message",
      kind: "text",
      from: { id: organizerId, displayName: "Reply Org" },
    })
    expect(reply.replyTo?.deleted).toBeUndefined()

    // A non-reply carries neither field.
    expect(original.replyToId).toBeUndefined()
    expect(original.replyTo).toBeUndefined()

    // History re-hydrates the same preview from the page's rows.
    const page = await repo.history(cleanupId, undefined, 10)
    const fromHistory = page.items.find((m) => m.id === reply.id)
    expect(fromHistory?.replyToId).toBe(original.id)
    expect(fromHistory?.replyTo).toMatchObject({
      id: original.id,
      excerpt: "original message",
      from: { id: organizerId, displayName: "Reply Org" },
    })
  })

  it("replying to a message in a DIFFERENT room -> 422 reply_wrong_room", async () => {
    const organizerId = await newUser("Wrong Room Org")
    const roomA = await newCleanup(organizerId, "Room A")
    const roomB = await newCleanup(organizerId, "Room B")
    const repo = makeDrizzleChatRepository(h.sql)

    const inB = await repo.insertMessage(
      { cleanupId: roomB, userId: organizerId, body: "lives in B" },
      randomUUID(),
    )
    await expectReplyError(
      repo.insertMessage(
        { cleanupId: roomA, userId: organizerId, body: "cross-room reply", replyToId: inB.id },
        randomUUID(),
      ),
      "reply_wrong_room",
    )
    // An id that exists nowhere is indistinguishable from wrong-room (same 422).
    await expectReplyError(
      repo.insertMessage(
        { cleanupId: roomA, userId: organizerId, body: "ghost reply", replyToId: randomUUID() },
        randomUUID(),
      ),
      "reply_wrong_room",
    )
  })

  it("replying to a tombstoned target -> 422 reply_deleted_target", async () => {
    const organizerId = await newUser("Deleted Target Org")
    const cleanupId = await newCleanup(organizerId, "Deleted target sweep")
    const repo = makeDrizzleChatRepository(h.sql)

    const original = await repo.insertMessage(
      { cleanupId, userId: organizerId, body: "soon deleted" },
      randomUUID(),
    )
    expect(await repo.softDelete(cleanupId, original.id, organizerId)).not.toBeNull()

    await expectReplyError(
      repo.insertMessage(
        { cleanupId, userId: organizerId, body: "too late", replyToId: original.id },
        randomUUID(),
      ),
      "reply_deleted_target",
    )
  })

  it("deleting the original AFTER the reply: history hydrates replyTo.deleted:true with empty excerpt", async () => {
    const organizerId = await newUser("Tombstone Org")
    const cleanupId = await newCleanup(organizerId, "Tombstone sweep")
    const repo = makeDrizzleChatRepository(h.sql)

    const original = await repo.insertMessage(
      { cleanupId, userId: organizerId, body: "secret original text" },
      randomUUID(),
    )
    const reply = await repo.insertMessage(
      { cleanupId, userId: organizerId, body: "reply first", replyToId: original.id },
      randomUUID(),
    )
    expect(await repo.softDelete(cleanupId, original.id, organizerId)).not.toBeNull()

    const page = await repo.history(cleanupId, undefined, 10)
    const fromHistory = page.items.find((m) => m.id === reply.id)
    expect(fromHistory?.replyToId).toBe(original.id)
    expect(fromHistory?.replyTo?.deleted).toBe(true)
    // The original text must not survive its deletion via the reply preview.
    expect(fromHistory?.replyTo?.excerpt).toBe("")
  })

  it("DM reply round-trip + thread-scoped validation", async () => {
    const a = await newUser("DM Reply A")
    const b = await newUser("DM Reply B")
    const c = await newUser("DM Reply C")
    const dm = makeDrizzleDmRepository(h.sql)
    const thread = await dm.openOrCreateThread(a, b)
    const otherThread = await dm.openOrCreateThread(a, c)

    const original = await dm.persist({ threadId: thread.id, senderId: a, body: "dm original" })
    const reply = await dm.persist({
      threadId: thread.id,
      senderId: b,
      body: "dm reply",
      replyToId: original.id,
    })
    expect(reply.replyToId).toBe(original.id)
    expect(reply.replyTo).toMatchObject({
      id: original.id,
      excerpt: "dm original",
      kind: "text",
      from: { id: a, displayName: "DM Reply A" },
    })

    const page = await dm.history(thread.id, undefined, 10, b)
    const fromHistory = page.items.find((m) => m.id === reply.id)
    expect(fromHistory?.replyTo).toMatchObject({ id: original.id, excerpt: "dm original" })

    // A target from ANOTHER thread is rejected the same way as chat rooms.
    await expectReplyError(
      dm.persist({
        threadId: otherThread.id,
        senderId: a,
        body: "cross-thread reply",
        replyToId: original.id,
      }),
      "reply_wrong_room",
    )
  })

  it("excerpt truncates at 120 chars", async () => {
    const organizerId = await newUser("Excerpt Org")
    const cleanupId = await newCleanup(organizerId, "Excerpt sweep")
    const repo = makeDrizzleChatRepository(h.sql)

    const longBody = "x".repeat(300)
    const original = await repo.insertMessage(
      { cleanupId, userId: organizerId, body: longBody },
      randomUUID(),
    )
    const reply = await repo.insertMessage(
      { cleanupId, userId: organizerId, body: "truncate me", replyToId: original.id },
      randomUUID(),
    )
    expect(reply.replyTo?.excerpt).toBe(longBody.slice(0, REPLY_EXCERPT_MAX))
    expect(reply.replyTo?.excerpt).toHaveLength(120)
  })
})
