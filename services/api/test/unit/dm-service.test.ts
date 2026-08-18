import { describe, it, expect, beforeEach } from "vitest"
import {
  makeDmService,
  DM_FORBIDDEN_MESSAGE,
  type DmService,
  type DmTargetUser,
} from "../../src/services/dm-service.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"
import type { AppError } from "@civfix/shared"


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
    expect(thread.ago).toBeNull()
    expect(thread.lastMessageAt).toBeNull()
  })

  it("carries the last message's ISO timestamp beside the rendered ago", async () => {
    const opened = await service.openDm(ALICE, BOB)
    const message = await dm.persist({ threadId: opened.id, senderId: BOB, body: "hey" })

    const thread = await service.openDm(ALICE, BOB)
    expect(thread.last).toBe("hey")
    expect(thread.lastMessageAt).toBe(new Date(message.createdAt).toISOString())
    expect(thread.ago).not.toBeNull()
  })

  it("is idempotent: a second openDm returns the same thread id", async () => {
    const a = await service.openDm(ALICE, BOB)
    const b = await service.openDm(BOB, ALICE)
    expect(b.id).toBe(a.id)
  })

  it("CVX-032: a MISSING target and a BLOCKED target produce the SAME response", async () => {
    await blocks.block(BOB, ALICE)
    const missing = await service
      .openDm(ALICE, "99999999-9999-9999-9999-999999999999")
      .then(() => null)
      .catch((e: AppError) => e)
    const blocked = await service
      .openDm(ALICE, BOB)
      .then(() => null)
      .catch((e: AppError) => e)
    expect(missing).not.toBeNull()
    expect({ status: missing!.httpStatus, message: missing!.message }).toEqual({
      status: 403,
      message: DM_FORBIDDEN_MESSAGE,
    })
    expect({ status: blocked!.httpStatus, message: blocked!.message }).toEqual({
      status: missing!.httpStatus,
      message: missing!.message,
    })
  })

  it("403s a self-DM", async () => {
    await expect(service.openDm(ALICE, ALICE)).rejects.toMatchObject({ httpStatus: 403 })
  })

  it("403s when the target has DMs disabled and no thread exists yet", async () => {
    await expect(service.openDm(ALICE, CAROL)).rejects.toMatchObject({ httpStatus: 403 })
    expect(await dm.getThreadForPair(ALICE, CAROL)).toBeNull()
  })

  it("opens an EXISTING thread even when the target later disables DMs", async () => {
    users.set(CAROL, user({ id: CAROL, displayName: "Carol", handle: "carol", allowDirectMessages: true }))
    const first = await service.openDm(ALICE, CAROL)
    users.set(CAROL, user({ id: CAROL, displayName: "Carol", handle: "carol", allowDirectMessages: false }))
    const again = await service.openDm(ALICE, CAROL)
    expect(again.id).toBe(first.id)
  })

  it("403s when either party blocked the other (and does not leak which)", async () => {
    await blocks.block(BOB, ALICE)
    await expect(service.openDm(ALICE, BOB)).rejects.toMatchObject({ httpStatus: 403 })
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
    await dm.persist({ threadId: opened.id, senderId: BOB, body: "yo" })
    await dm.persist({ threadId: opened.id, senderId: BOB, body: "you there?" })
    await dm.persist({ threadId: opened.id, senderId: ALICE, body: "hi" })
    expect((await service.openDm(ALICE, BOB)).unread).toBe(2)
    expect((await service.openDm(BOB, ALICE)).unread).toBe(1)

    await dm.markRead(opened.id, ALICE, new Date())
    expect((await service.openDm(ALICE, BOB)).unread).toBe(0)
  })

  it("an unread lookup failure fails OPEN (0) rather than failing the open", async () => {
    const opened = await service.openDm(ALICE, BOB)
    await dm.persist({ threadId: opened.id, senderId: BOB, body: "yo" })
    dm.countUnread = () => Promise.reject(new Error("db down"))
    const thread = await service.openDm(ALICE, BOB)
    expect(thread.unread).toBe(0)
    expect(thread.id).toBe(opened.id)
  })
})
