/**
 * The chat-room powers resolver is the SINGLE source of truth for who may pin / delete-others in a
 * chat room. The full matrix:
 *
 *   dm       participant        -> pin YES,  delete-others NO (always), not a moderator
 *   dm       non-participant    -> nothing
 *   cleanup  organizer/cohost   -> pin YES,  delete-others YES
 *   cleanup  member             -> nothing
 *   report   owner              -> pin YES,  delete-others NO (public civic space)
 *   report   member             -> nothing
 *   operator in a REPORT room   -> pin YES,  delete-others YES (even without a membership row)
 *   operator in a CLEANUP room  -> NOTHING beyond their cleanup_members role
 *   unknown / non-member        -> nothing
 *
 * Lane isolation is asserted with throwing stubs: each room kind may only consult its own
 * lookup(s) (dm -> participant; cleanup -> cleanup role ONLY, operator status is deliberately
 * never consulted there; report -> report role + global role).
 */

import { describe, it, expect } from "vitest"
import {
  makeChatPowersResolver,
  type ChatRoomRoleDeps,
  type ChatPowers,
} from "../../src/services/chat-room-roles.js"

const USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const ROOM = "cccccccc-cccc-cccc-cccc-cccccccccccc"

const NONE: ChatPowers = { canPin: false, canDeleteOthers: false, isModerator: false }

/** Deps where every lookup throws unless overridden, which proves which lanes are consulted. */
function deps(overrides: Partial<ChatRoomRoleDeps>): ChatRoomRoleDeps {
  const never = (name: string) => async () => {
    throw new Error(`unexpected dep call: ${name}`)
  }
  return {
    isDmParticipant: never("isDmParticipant"),
    cleanupRoleOf: never("cleanupRoleOf"),
    reportChatRoleOf: never("reportChatRoleOf"),
    globalRoleOf: never("globalRoleOf"),
    groupRoleOf: never("groupRoleOf"),
    ...overrides,
  }
}

describe("resolveChatPowers: dm rooms", () => {
  it("participant: canPin, NEVER canDeleteOthers, not a moderator (peer power, not moderation)", async () => {
    const resolve = makeChatPowersResolver(deps({ isDmParticipant: async () => true }))
    await expect(resolve({ roomKind: "dm", roomId: ROOM, userId: USER })).resolves.toEqual({
      canPin: true,
      canDeleteOthers: false,
      isModerator: false,
    })
  })

  it("non-participant: nothing", async () => {
    const resolve = makeChatPowersResolver(deps({ isDmParticipant: async () => false }))
    await expect(resolve({ roomKind: "dm", roomId: ROOM, userId: USER })).resolves.toEqual(NONE)
  })

  it("consults ONLY the participant lookup (an operator gets nothing extra in a dm)", async () => {
    // cleanupRoleOf / reportChatRoleOf / globalRoleOf all throw: resolving must not touch them.
    const resolve = makeChatPowersResolver(deps({ isDmParticipant: async () => true }))
    const powers = await resolve({ roomKind: "dm", roomId: ROOM, userId: USER })
    expect(powers.canDeleteOthers).toBe(false)
  })
})

describe("resolveChatPowers: cleanup rooms", () => {
  it("organizer: canPin AND canDeleteOthers (room moderator)", async () => {
    const resolve = makeChatPowersResolver(deps({ cleanupRoleOf: async () => "organizer" }))
    await expect(resolve({ roomKind: "cleanup", roomId: ROOM, userId: USER })).resolves.toEqual({
      canPin: true,
      canDeleteOthers: true,
      isModerator: true,
    })
  })

  it("cohost: canPin AND canDeleteOthers (organizer-equivalent for chat)", async () => {
    const resolve = makeChatPowersResolver(deps({ cleanupRoleOf: async () => "cohost" }))
    await expect(resolve({ roomKind: "cleanup", roomId: ROOM, userId: USER })).resolves.toEqual({
      canPin: true,
      canDeleteOthers: true,
      isModerator: true,
    })
  })

  it("plain member: nothing", async () => {
    const resolve = makeChatPowersResolver(deps({ cleanupRoleOf: async () => "member" }))
    await expect(resolve({ roomKind: "cleanup", roomId: ROOM, userId: USER })).resolves.toEqual(
      NONE,
    )
  })

  it("non-member: nothing", async () => {
    const resolve = makeChatPowersResolver(deps({ cleanupRoleOf: async () => null }))
    await expect(resolve({ roomKind: "cleanup", roomId: ROOM, userId: USER })).resolves.toEqual(
      NONE,
    )
  })

  it("operator gets NOTHING beyond their cleanup role: globalRoleOf is never even consulted", async () => {
    // globalRoleOf throws; a plain-member operator must resolve to nothing without touching it.
    const resolve = makeChatPowersResolver(deps({ cleanupRoleOf: async () => "member" }))
    await expect(resolve({ roomKind: "cleanup", roomId: ROOM, userId: USER })).resolves.toEqual(
      NONE,
    )
  })
})

describe("resolveChatPowers: report rooms", () => {
  it("owner: canPin but NOT canDeleteOthers (public civic space); still a moderator", async () => {
    const resolve = makeChatPowersResolver(
      deps({ reportChatRoleOf: async () => "owner", globalRoleOf: async () => "citizen" }),
    )
    await expect(resolve({ roomKind: "report", roomId: ROOM, userId: USER })).resolves.toEqual({
      canPin: true,
      canDeleteOthers: false,
      isModerator: true,
    })
  })

  it("plain member: nothing", async () => {
    const resolve = makeChatPowersResolver(
      deps({ reportChatRoleOf: async () => "member", globalRoleOf: async () => "citizen" }),
    )
    await expect(resolve({ roomKind: "report", roomId: ROOM, userId: USER })).resolves.toEqual(NONE)
  })

  it("non-member: nothing", async () => {
    const resolve = makeChatPowersResolver(
      deps({ reportChatRoleOf: async () => null, globalRoleOf: async () => "citizen" }),
    )
    await expect(resolve({ roomKind: "report", roomId: ROOM, userId: USER })).resolves.toEqual(NONE)
  })

  it("operator (member): canPin AND canDeleteOthers", async () => {
    const resolve = makeChatPowersResolver(
      deps({ reportChatRoleOf: async () => "member", globalRoleOf: async () => "operator" }),
    )
    await expect(resolve({ roomKind: "report", roomId: ROOM, userId: USER })).resolves.toEqual({
      canPin: true,
      canDeleteOthers: true,
      isModerator: true,
    })
  })

  it("operator without a membership row: still both (operators moderate the public room)", async () => {
    const resolve = makeChatPowersResolver(
      deps({ reportChatRoleOf: async () => null, globalRoleOf: async () => "operator" }),
    )
    await expect(resolve({ roomKind: "report", roomId: ROOM, userId: USER })).resolves.toEqual({
      canPin: true,
      canDeleteOthers: true,
      isModerator: true,
    })
  })

  it("gov roles are NOT operators: gov_admin member gets nothing", async () => {
    const resolve = makeChatPowersResolver(
      deps({ reportChatRoleOf: async () => "member", globalRoleOf: async () => "gov_admin" }),
    )
    await expect(resolve({ roomKind: "report", roomId: ROOM, userId: USER })).resolves.toEqual(NONE)
  })

  it("unknown global role (user row missing): membership alone still resolves", async () => {
    const resolve = makeChatPowersResolver(
      deps({ reportChatRoleOf: async () => "owner", globalRoleOf: async () => null }),
    )
    await expect(resolve({ roomKind: "report", roomId: ROOM, userId: USER })).resolves.toEqual({
      canPin: true,
      canDeleteOthers: false,
      isModerator: true,
    })
  })
})

describe("resolveChatPowers: group rooms (P4)", () => {
  it("owner: both powers + moderator (only groupRoleOf consulted; throwing stubs prove isolation)", async () => {
    const resolve = makeChatPowersResolver(deps({ groupRoleOf: async () => "owner" }))
    await expect(resolve({ roomKind: "group", roomId: ROOM, userId: USER })).resolves.toEqual({
      canPin: true,
      canDeleteOthers: true,
      isModerator: true,
    })
  })

  it("admin: both powers + moderator", async () => {
    const resolve = makeChatPowersResolver(deps({ groupRoleOf: async () => "admin" }))
    await expect(resolve({ roomKind: "group", roomId: ROOM, userId: USER })).resolves.toEqual({
      canPin: true,
      canDeleteOthers: true,
      isModerator: true,
    })
  })

  it("member: nothing", async () => {
    const resolve = makeChatPowersResolver(deps({ groupRoleOf: async () => "member" }))
    await expect(resolve({ roomKind: "group", roomId: ROOM, userId: USER })).resolves.toEqual(NONE)
  })

  it("non-member: nothing; operators get NOTHING extra (globalRoleOf never consulted)", async () => {
    // deps() leaves globalRoleOf throwing: resolving proves the group lane never looks at it.
    const resolve = makeChatPowersResolver(deps({ groupRoleOf: async () => null }))
    await expect(resolve({ roomKind: "group", roomId: ROOM, userId: USER })).resolves.toEqual(NONE)
  })
})

describe("resolveChatPowers: unknown room kind", () => {
  it("resolves to nothing without consulting any lookup", async () => {
    const resolve = makeChatPowersResolver(deps({}))
    await expect(
      // Simulates a corrupt/forged kind arriving through an any-typed boundary.
      resolve({ roomKind: "banana" as never, roomId: ROOM, userId: USER }),
    ).resolves.toEqual(NONE)
  })
})
