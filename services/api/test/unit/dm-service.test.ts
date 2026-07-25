import { describe, it, expect, beforeEach } from "vitest"
import { makeDmService, type DmService, type DmTargetUser } from "../../src/services/dm-service.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"
import type { AppError } from "@civfix/shared"

/**
 * DM service unit tests (no DB): openDm rules.
 *   - disabled target with no existing thread -> 403 (generic message);
 *   - blocked either way -> 403;
 *   - self -> 403; missing target -> 404;
 *   - normal -> creates a thread, MessageThreadDTO with kind:"dm", peer, display-name title;
 *   - idempotent: a second openDm returns the SAME thread id;
 *   - DM-disabled but an EXISTING thread still opens (existing threads keep working).
 */

const ALICE = "11111111-1111-1111-1111-111111111111"
const BOB = "22222222-2222-2222-2222-222222222222"
const CAROL = "33333333-3333-3333-3333-333333333333"

let dm: InMemoryDmRepository
let blocks: InMemoryBlocksRepository
let users: Map<string, DmTargetUser>
let service: DmService

function user(over: Partial<DmTargetUser> & { id: string }): DmTargetUser {
  return {
    displayName: `User ${over.id.slice(0, 4)}`,
    handle: null,
    bio: null,
    avatarUrl: null,
    allowDirectMessages: true,
    ...over,
  }
}

beforeEach(() => {
  blocks = new InMemoryBlocksRepository()
  dm = new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b))
  users = new Map()
  users.set(ALICE, user({ id: ALICE, displayName: "Alice", handle: "alice" }))
  users.set(BOB, user({ id: BOB, displayName: "Bob", handle: "bob" }))
  users.set(CAROL, user({ id: CAROL, displayName: "Carol", handle: "carol", allowDirectMessages: false }))
  service = makeDmService({
    dm,
    blocks,
    loadUser: (id) => Promise.resolve(users.get(id) ?? null),
    now: () => new Date("2026-06-07T12:00:00.000Z"),
  })
})

describe("DmService.openDm", () => {
  it("creates a thread and returns a dm MessageThreadDTO with peer + display-name title", async () => {
    const thread = await service.openDm(ALICE, BOB)
    expect(thread.kind).toBe("dm")
    expect(thread.title).toBe("Bob")
    expect(thread.peer?.id).toBe(BOB)
    expect(thread.members).toBe(2)
    expect(thread.unread).toBe(0)
    expect(thread.refId).toBe(thread.id)
    expect(thread.last).toBeNull()
  })

  it("is idempotent: a second openDm returns the same thread id", async () => {
    const a = await service.openDm(ALICE, BOB)
    const b = await service.openDm(BOB, ALICE) // reverse order, same pair
    expect(b.id).toBe(a.id)
  })

  it("404s a missing target", async () => {
    await expect(service.openDm(ALICE, "99999999-9999-9999-9999-999999999999")).rejects.toMatchObject({
      httpStatus: 404,
    } satisfies Partial<AppError>)
  })

  it("403s a self-DM", async () => {
    await expect(service.openDm(ALICE, ALICE)).rejects.toMatchObject({ httpStatus: 403 })
  })

  it("403s when the target has DMs disabled and no thread exists yet", async () => {
    await expect(service.openDm(ALICE, CAROL)).rejects.toMatchObject({ httpStatus: 403 })
    // No thread was created (the rule must not silently spin one up).
    expect(await dm.getThreadForPair(ALICE, CAROL)).toBeNull()
  })

  it("opens an EXISTING thread even when the target later disables DMs", async () => {
    // Carol allows DMs, open a thread, then she disables: the existing thread still opens.
    users.set(CAROL, user({ id: CAROL, displayName: "Carol", handle: "carol", allowDirectMessages: true }))
    const first = await service.openDm(ALICE, CAROL)
    users.set(CAROL, user({ id: CAROL, displayName: "Carol", handle: "carol", allowDirectMessages: false }))
    const again = await service.openDm(ALICE, CAROL)
    expect(again.id).toBe(first.id)
  })

  it("403s when either party blocked the other (and does not leak which)", async () => {
    await blocks.block(BOB, ALICE) // Bob blocked Alice
    await expect(service.openDm(ALICE, BOB)).rejects.toMatchObject({ httpStatus: 403 })
    // Same generic outcome the other direction.
    await blocks.unblock(BOB, ALICE)
    await blocks.block(ALICE, BOB)
    await expect(service.openDm(ALICE, BOB)).rejects.toMatchObject({ httpStatus: 403 })
  })

  it("projects last/ago/lastFromMe from the most recent message", async () => {
    const opened = await service.openDm(ALICE, BOB)
    await dm.persist({ threadId: opened.id, senderId: ALICE, body: "hey" })
    const reopened = await service.openDm(ALICE, BOB)
    expect(reopened.last).toBe("hey")
    expect(reopened.lastFromMe).toBe(true)
    expect(reopened.ago).not.toBeNull()
  })

  it("reports the viewer's REAL unread: peer messages count, own don't, and a read clears it", async () => {
    const opened = await service.openDm(ALICE, BOB)
    // Two from the peer + one of the viewer's own: unread counts only the peer's (you are never unread
    // on what you wrote). This used to be a hardcoded 0, so a thread opened from a profile rendered with
    // no badge until the inbox refetched and threads-service stamped the real count.
    await dm.persist({ threadId: opened.id, senderId: BOB, body: "yo" })
    await dm.persist({ threadId: opened.id, senderId: BOB, body: "you there?" })
    await dm.persist({ threadId: opened.id, senderId: ALICE, body: "hi" })
    expect((await service.openDm(ALICE, BOB)).unread).toBe(2)
    // The PEER's own view of the same thread: Alice's one message is unread for Bob.
    expect((await service.openDm(BOB, ALICE)).unread).toBe(1)

    // Reading up to now clears it (same watermark the inbox uses).
    await dm.markRead(opened.id, ALICE, new Date())
    expect((await service.openDm(ALICE, BOB)).unread).toBe(0)
  })

  it("an unread lookup failure fails OPEN (0) rather than failing the open", async () => {
    const opened = await service.openDm(ALICE, BOB)
    await dm.persist({ threadId: opened.id, senderId: BOB, body: "yo" })
    // The repo instance is rebuilt per test, so patching it here needs no restore.
    dm.countUnread = () => Promise.reject(new Error("db down"))
    const thread = await service.openDm(ALICE, BOB)
    expect(thread.unread).toBe(0)
    expect(thread.id).toBe(opened.id)
  })
})
