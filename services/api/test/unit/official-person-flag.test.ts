import { describe, expect, it } from "vitest"
import type { PersonDTO } from "@civfix/shared"
import type { Sql } from "../../src/db/client.js"
import { makeFakeSql, type SqlHandler } from "../helpers/fake-sql.js"
import { InMemoryThreadsRepository } from "../helpers/chat.js"
import { InMemorySocialRepository } from "../helpers/social.js"
import { CIVFIX_OFFICIAL_USER_ID, officialPersonFlag } from "../../src/auth/official-account.js"
import { makeDrizzleChatRepository } from "../../src/services/chat-repository.drizzle.js"
import { makeDrizzleDmRepository } from "../../src/services/dm-repository.drizzle.js"
import { makeDrizzleBlocksRepository } from "../../src/services/blocks-repository.drizzle.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"
import { toReportParticipantDTO } from "../../src/services/report-chat-repository.drizzle.js"
import { toMemberView } from "../../src/services/chat-group-repository.drizzle.js"
import { makeDrizzlePostRepository } from "../../src/services/post-repository.drizzle.js"
import { makeDrizzleAnnouncementIdentityRepository } from "../../src/services/host/announcement-identity-repository.drizzle.js"
import { makeSocialService, toPersonDTO } from "../../src/services/social-service.js"
import { toAttendeeDTO, toLinkedEventRef } from "../../src/services/cleanup-dto.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { toWaitlistEntryDTO } from "../../src/services/host/registration-dto.js"
import { InMemoryChatReadState, makeThreadsService } from "../../src/services/threads-service.js"
import { makeDmService } from "../../src/services/dm-service.js"

const OFFICIAL = CIVFIX_OFFICIAL_USER_ID
const RESIDENT = "22222222-2222-4222-8222-222222222222"
const VIEWER = "33333333-3333-4333-8333-333333333333"
const ROOM = "44444444-4444-4444-8444-444444444444"
const MESSAGE = "55555555-5555-4555-8555-555555555555"
const EVENT = "66666666-6666-4666-8666-666666666666"
const ORIGINAL = "77777777-7777-4777-8777-777777777777"
const AT = new Date("2026-09-01T00:00:00.000Z")
const PEOPLE = [
  ["the official account", OFFICIAL, true],
  ["a resident", RESIDENT, false],
] as const

function expectFlag(person: PersonDTO | null | undefined, official: boolean): void {
  expect(person).toBeTruthy()
  if (official) expect(person).toHaveProperty("official", true)
  else expect(person).not.toHaveProperty("official")
}

function fakeSql(handlers: SqlHandler[]): Sql {
  return makeFakeSql(handlers).sql as unknown as Sql
}

const identity = { display_name: "Name", handle: "name", bio: null, avatar_url: null }
const person = { displayName: "Name", handle: "name", bio: null, avatarUrl: null }

const messageRow = (senderId: string, deletedAt: Date | null) => ({
  id: MESSAGE,
  body: "hello",
  kind: "text",
  attachments: [],
  created_at: AT,
  edited_at: null,
  deleted_at: null,
  reply_to_id: null,
  pinned_at: null,
  sender_id: senderId,
  sender_display_name: "Name",
  sender_handle: "name",
  sender_bio: null,
  sender_avatar_url: null,
  sender_deleted_at: deletedAt,
})

async function chatSender(id: string, deletedAt: Date | null = null) {
  const row = {
    ...messageRow(id, deletedAt),
    cleanup_id: ROOM,
    report_id: null,
    group_id: null,
    system_status: null,
    system_kind: null,
    system_body: null,
  }
  const repo = makeDrizzleChatRepository(
    fakeSql([{ match: /FROM chat_messages cm LEFT JOIN users u/, rows: [row] }]),
  )
  return (await repo.findMessage(ROOM, MESSAGE, VIEWER))?.from
}

async function dmSender(id: string, deletedAt: Date | null = null) {
  const row = { ...messageRow(id, deletedAt), thread_id: ROOM }
  const repo = makeDrizzleDmRepository(
    fakeSql([{ match: /FROM dm_messages dm JOIN users u/, rows: [row] }]),
  )
  return (await repo.findMessage(ROOM, MESSAGE, VIEWER))?.from
}

const rosterRow = (userId: string, over: { deleted?: boolean; blocked?: boolean } = {}) => ({
  ...identity,
  user_id: userId,
  role: "member" as const,
  joined_at: AT,
  user_deleted_at: over.deleted ? AT : null,
  is_following: false,
  blocked_pair: over.blocked ?? false,
})

function rosterUsers(userId: string, over: { deleted?: boolean; blocked?: boolean } = {}) {
  const row = rosterRow(userId, over)
  return [toReportParticipantDTO(row).user, toMemberView(row).user]
}

async function attendeeRosterUser(userId: string, blocked: boolean) {
  const row = { ...identity, id: userId, role: "member", is_following: false }
  const rows = [{ ...row, blocked_pair: blocked, slot_id: null, slot_title: null }]
  const repo = makeDrizzleCleanupRepository(fakeSql([{ match: /FROM cleanup_members m/, rows }]))
  const args = { cleanupId: EVENT, viewerId: VIEWER, onlyFollowed: false, limit: 1 }
  const [view] = await repo.listAttendees(args)
  return toAttendeeDTO(view!, false)
}

const counts = { like_count: 0, repost_count: 0, reply_count: 0, save_count: 0 }

function postRepo(id: string, deletedAt: Date | null = null) {
  const post = {
    id: MESSAGE,
    author_id: id,
    kind: "quote",
    body: "quoting",
    reply_to_id: null,
    thread_root_id: null,
    repost_of_id: ORIGINAL,
    event_id: EVENT,
    report_id: null,
    ...counts,
    organization_id: null,
    created_at: AT,
    updated_at: AT,
  }
  const author = {
    ...identity,
    id,
    followers: 0,
    following: 0,
    avatar_r2_key: null,
    is_following: false,
    deleted_at: deletedAt,
  }
  const original = {
    ...post,
    ...identity,
    id: ORIGINAL,
    kind: "post",
    repost_of_id: null,
    event_id: null,
    deleted_at: null,
    visibility: "public",
  }
  const event = {
    id: EVENT,
    title: "Sweep",
    event_kind: "cleanup",
    status: "upcoming",
    scheduled_at: AT,
    ends_at: null,
    timezone: null,
    lat: 0,
    lng: 0,
    going: 0,
    org_id: id,
    org_name: "Name",
    org_handle: "name",
    org_bio: null,
    org_avatar_url: null,
    org_donation_url: null,
  }
  return makeDrizzlePostRepository(
    fakeSql([
      { match: /FROM posts p WHERE p\.id = \?/, rows: [post] },
      { match: /LEFT JOIN media_assets am ON am\.id = u\.avatar_media_id/, rows: [author] },
      { match: /LEFT JOIN users u ON u\.id = p\.author_id/, rows: [original] },
      { match: /JOIN users u ON u\.id = c\.organizer_user_id/, rows: [event] },
    ]),
    {
      presignMedia: () => Promise.resolve({ url: "u" }),
      presignAvatar: () => Promise.resolve("a"),
    },
  )
}

async function announcementAuthor(id: string, deletedAt: Date | null = null) {
  const row = { ...identity, id, avatar_r2_key: null, deleted_at: deletedAt }
  const repo = makeDrizzleAnnouncementIdentityRepository(
    fakeSql([{ match: /FROM users u\s+LEFT JOIN media_assets am/, rows: [row] }]),
    () => Promise.resolve("a"),
  )
  return (await repo.authorsFor([id])).get(id)
}

async function dmThreadPeer(dm: InMemoryDmRepository) {
  const threads = makeThreadsService({
    repo: new InMemoryThreadsRepository(),
    readState: new InMemoryChatReadState(),
    dm: { listDmThreadsFor: (userId) => dm.listThreadsForUser(userId) },
  })
  return (await threads.listThreads(VIEWER, 30)).items[0]?.peer
}

const registrant = (userId: string, deletedAt: Date | null = null) =>
  toWaitlistEntryDTO({
    id: MESSAGE,
    cleanupId: EVENT,
    ticketTypeId: ORIGINAL,
    ticketTypeName: null,
    userId,
    guestId: null,
    guestName: null,
    identity: { ...person, userId, deletedAt },
    partySize: 1,
    status: "waiting",
    position: 1,
    createdAt: AT,
    offeredAt: null,
    claimExpiresAt: null,
  }).person

const linkedEventOrganizer = (view: typeof person & { id: string }) =>
  toLinkedEventRef({
    reportId: ROOM,
    id: EVENT,
    title: "Sweep",
    eventKind: "cleanup",
    status: "upcoming",
    scheduledAt: AT,
    endsAt: null,
    timezone: null,
    lat: 0,
    lng: 0,
    going: 0,
    organizer: view,
    linkedAt: AT,
  }).organizer

describe("officialPersonFlag", () => {
  it("flags only the official id, in any letter case, and omits the key for anyone else", () => {
    expect(officialPersonFlag(OFFICIAL)).toEqual({ official: true })
    expect(officialPersonFlag(OFFICIAL.toUpperCase())).toEqual({ official: true })
    expect(officialPersonFlag(RESIDENT)).toEqual({})
  })
})

describe.each(PEOPLE)("PersonDTO projections of %s", (_label, id, official) => {
  it("chat and DM message senders", async () => {
    expectFlag(await chatSender(id), official)
    expectFlag(await dmSender(id), official)
  })

  it("report chat and group rosters", () => {
    for (const user of rosterUsers(id)) expectFlag(user, official)
  })

  it("post author, quoted author and linked event organizer", async () => {
    const dto = await postRepo(id).getPostDTO(MESSAGE, VIEWER)
    expectFlag(dto?.author, official)
    expectFlag(dto?.repostOf?.author, official)
    expectFlag(dto?.event?.organizer, official)
  })

  it("announcement author", async () => {
    expectFlag(await announcementAuthor(id), official)
  })

  it("people lists, profile and blocked-profile shell", async () => {
    const repo = new InMemorySocialRepository()
    repo.seedUser({ id, displayName: "Name" })
    const [view] = (await repo.listPeople({ viewerId: null, q: null, cursor: null, limit: 1 }))
      .items
    expectFlag(toPersonDTO(view!, false), official)
    const open = makeSocialService({ repo })
    expectFlag((await open.getProfile(id, { userId: VIEWER })).profile, official)
    const blocked = makeSocialService({
      repo,
      blockState: () => Promise.resolve({ blockedByViewer: true, blockedByTarget: false }),
    })
    expectFlag((await blocked.getProfile(id, { userId: VIEWER })).profile, official)
  })

  it("event attendees, organizers and registrants", async () => {
    const view = { ...person, id }
    expectFlag(toAttendeeDTO({ ...view, isFollowing: false, role: "member" }, false), official)
    expectFlag(await attendeeRosterUser(id, false), official)
    expectFlag(linkedEventOrganizer(view), official)
    expectFlag(registrant(id), official)
  })

  it("DM threads, opened DM peers and blocked lists", async () => {
    const blocks = new InMemoryBlocksRepository()
    const dm = new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b))
    dm.registerUser({ ...person, id })
    const thread = await dm.openOrCreateThread(VIEWER, id)
    expectFlag((await dm.persist({ threadId: thread.id, senderId: id, body: "hi" })).from, official)
    expectFlag(await dmThreadPeer(dm), official)
    const dmService = makeDmService({
      dm,
      blocks,
      loadUser: (userId) => Promise.resolve({ ...person, id: userId, allowDirectMessages: true }),
    })
    expectFlag((await dmService.openDm(VIEWER, id)).peer, official)
    blocks.registerUser({ ...person, id })
    await blocks.block(VIEWER, id)
    expectFlag((await blocks.listBlocked(VIEWER)).blocked[0], official)
    const drizzleBlocks = makeDrizzleBlocksRepository(
      fakeSql([
        { match: /FROM user_blocks b\s+JOIN users u/, rows: [{ ...identity, id, created_at: AT }] },
      ]),
    )
    expectFlag((await drizzleBlocks.listBlocked(VIEWER)).blocked[0], official)
  })
})

describe("the official flag never survives a tombstone or a hidden identity", () => {
  it("drops it from a deleted chat, DM, post or announcement author", async () => {
    const authors = [
      await chatSender(OFFICIAL, AT),
      await dmSender(OFFICIAL, AT),
      (await postRepo(OFFICIAL, AT).getPostDTO(MESSAGE, VIEWER))?.author,
      await announcementAuthor(OFFICIAL, AT),
    ]
    for (const author of authors) {
      expect(author).toMatchObject({ deleted: true })
      expectFlag(author, false)
    }
  })

  it("drops it from a deleted DM peer and a deleted registrant", async () => {
    const dm = new InMemoryDmRepository(() => Promise.resolve(false))
    dm.registerUser({ ...person, id: OFFICIAL, deletedAt: AT })
    await dm.openOrCreateThread(VIEWER, OFFICIAL)
    for (const person of [await dmThreadPeer(dm), registrant(OFFICIAL, AT)]) {
      expect(person).toMatchObject({ deleted: true })
      expectFlag(person, false)
    }
  })

  it("drops it from a deleted or blocked-pair roster row", async () => {
    for (const over of [{ deleted: true }, { blocked: true }]) {
      for (const user of rosterUsers(OFFICIAL, over)) expectFlag(user, false)
    }
    const hidden = await attendeeRosterUser(OFFICIAL, true)
    expect(hidden).toMatchObject({ name: "Community member", handle: null })
    expectFlag(hidden, false)
  })
})
