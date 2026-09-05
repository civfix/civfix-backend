import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { ChatMessageDTO } from "@civfix/shared"
import { toTombstoneDTO, liveMessageIds } from "../../src/services/chat-tombstone.js"
import { InMemoryChatRepository } from "../helpers/chat.js"
import { InMemoryDmRepository } from "../../src/services/dm-repository.memory.js"

const DELETED_AT = new Date(Date.UTC(2026, 5, 1, 12, 0, 0))

function loadedMessage(): ChatMessageDTO {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    cleanupId: "22222222-2222-4222-8222-222222222222",
    roomKind: "report",
    from: {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Sender",
      handle: "sender",
      bio: null,
      avatar: ["#000000", "#ffffff"],
      followers: 0,
      following: 0,
      isFollowing: false,
    },
    body: "home address 123 Fake St",
    kind: "text",
    attachments: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        kind: "image",
        codec: null,
        url: "https://cdn.test/secret.jpg",
        width: 10,
        height: 10,
        status: "ready",
      },
    ],
    reactions: [{ emoji: "heart", count: 1, mine: true }],
    mentions: [{ id: "55555555-5555-4555-8555-555555555555", handle: "peer", displayName: "Peer" }],
    createdAt: "2026-06-01T11:00:00.000Z",
    editedAt: "2026-06-01T11:30:00.000Z",
    pinnedAt: "2026-06-01T11:40:00.000Z",
    replyToId: "66666666-6666-4666-8666-666666666666",
    replyTo: { id: "66666666-6666-4666-8666-666666666666", from: null, excerpt: "hi", kind: "text" },
    forwardedToCity: true,
    cityMention: { handle: "losangeles", geoid: "0644000", name: "Los Angeles", forwarded: true },
    poll: {
      question: "where does the victim live?",
      options: [{ idx: 0, text: "123 Fake St", count: 1, mine: true }],
      totalVoters: 1,
      allowMultiple: false,
      anonymous: false,
      closed: false,
      myVote: [0],
    },
    system: { status: "in_progress", kind: "note", body: "operator note with a home address" },
    mine: true,
    clientId: "c_abc",
  }
}

describe("toTombstoneDTO", () => {
  it("strips every content surface and keeps only linkage", () => {
    const t = toTombstoneDTO(loadedMessage(), DELETED_AT)

    expect(t.body ?? null).toBeNull()
    expect(t.attachments).toEqual([])
    expect(t.reactions).toEqual([])
    expect(t.mentions).toEqual([])
    expect(t.poll ?? null).toBeNull()
    expect(t.system ?? null).toBeNull()
    expect(t.editedAt ?? null).toBeNull()
    expect(t.pinnedAt ?? null).toBeNull()
    expect(t.cityMention ?? null).toBeNull()

    expect(t.id).toBe("11111111-1111-4111-8111-111111111111")
    expect(t.cleanupId).toBe("22222222-2222-4222-8222-222222222222")
    expect(t.roomKind).toBe("report")
    expect(t.kind).toBe("text")
    expect(t.createdAt).toBe("2026-06-01T11:00:00.000Z")
    expect(t.deletedAt).toBe(DELETED_AT.toISOString())
    expect(t.from?.id).toBe("33333333-3333-4333-8333-333333333333")
    expect(t.replyToId).toBe("66666666-6666-4666-8666-666666666666")
    expect(t.mine).toBe(true)
    expect(t.clientId).toBe("c_abc")
  })

  it("is idempotent", () => {
    const once = toTombstoneDTO(loadedMessage(), DELETED_AT)
    expect(toTombstoneDTO(once, DELETED_AT)).toEqual(once)
  })
})

describe("liveMessageIds", () => {
  it("drops tombstoned ids so the attachment/reaction/mention loaders never see them", () => {
    expect(
      liveMessageIds([
        { id: "a", deleted_at: null },
        { id: "b", deleted_at: DELETED_AT },
        { id: "c", deleted_at: null },
      ]),
    ).toEqual(["a", "c"])
  })
})

describe("in-memory chat repository tombstones (around-mode anchor)", () => {
  const sender = { id: randomUUID(), displayName: "Sender", handle: "sender" }
  const peer = { id: randomUUID(), displayName: "Peer", handle: "peer" }

  it("the around anchor and the softDelete response carry no body/reactions", async () => {
    const repo = new InMemoryChatRepository()
    repo.registerSender(sender)
    repo.registerSender(peer)
    const cleanupId = randomUUID()
    const victim = await repo.insertMessage(
      { cleanupId, userId: sender.id, body: "secret" },
      randomUUID(),
    )
    await repo.insertMessage({ cleanupId, userId: sender.id, body: "after" }, randomUUID())
    await repo.toggleReaction(victim.id, peer.id, "heart")

    const live = await repo.history(cleanupId, undefined, 20, peer.id, victim.id)
    expect(live.items.find((m) => m.id === victim.id)?.body).toBe("secret")

    const deleted = await repo.softDelete(cleanupId, victim.id, sender.id)
    expect(deleted?.body ?? null).toBeNull()
    expect(deleted?.reactions).toEqual([])

    const page = await repo.history(cleanupId, undefined, 20, peer.id, victim.id)
    const tombstone = page.items.find((m) => m.id === victim.id)
    expect(tombstone?.deletedAt).toBeTruthy()
    expect(tombstone?.body ?? null).toBeNull()
    expect(tombstone?.attachments ?? []).toEqual([])
    expect(tombstone?.reactions ?? []).toEqual([])
    expect(tombstone?.mentions ?? []).toEqual([])
  })
})

describe("in-memory dm repository tombstones (around-mode anchor)", () => {
  it("an unsent DM leaks no body or reactions to the peer", async () => {
    const repo = new InMemoryDmRepository()
    const a = randomUUID()
    const b = randomUUID()
    repo.registerUser({ id: a, displayName: "A", handle: "dm-a" })
    repo.registerUser({ id: b, displayName: "B", handle: "dm-b" })
    const thread = await repo.openOrCreateThread(a, b)
    const victim = await repo.persist({ threadId: thread.id, senderId: a, body: "private" })
    await repo.persist({ threadId: thread.id, senderId: b, body: "after" })
    await repo.toggleReaction(victim.id, b, "heart")

    expect(await repo.softDelete(thread.id, victim.id, a)).not.toBeNull()

    const page = await repo.history(thread.id, undefined, 20, b, victim.id)
    const tombstone = page.items.find((m) => m.id === victim.id)
    expect(tombstone?.deletedAt).toBeTruthy()
    expect(tombstone?.body ?? null).toBeNull()
    expect(tombstone?.attachments ?? []).toEqual([])
    expect(tombstone?.reactions ?? []).toEqual([])
    expect(tombstone?.mentions ?? []).toEqual([])
  })
})
