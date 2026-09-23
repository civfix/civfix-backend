import { describe, it, expect, vi } from "vitest"
import type { UserMentionDTO } from "@civfix/shared"
import {
  makeChatMentionResolver,
  resolveAndRecordChatMentions,
  type ChatMentionResolverDeps,
} from "../../src/services/chat-mention-resolver.js"
import { THREAD_SIGNAL_MEMBER_CAP } from "../../src/services/cleanup-service.js"
import { REPORT_CHAT_MEMBER_SCAN_CAP } from "../../src/services/report-chat-repository.drizzle.js"
import { GROUP_MEMBER_SCAN_CAP } from "../../src/services/chat-group-repository.drizzle.js"

const AUTHOR = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const ROOM = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
const STRANGER = "cccccccc-cccc-cccc-cccc-cccccccccccc"

function memberIds(n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  )
}

function mention(id: string): UserMentionDTO {
  return { id, handle: `h${id.slice(-4)}`, displayName: "Member" }
}

/**
 * A member lookup shaped like the repositories: a numeric second argument is a LIMIT over the roster
 * in join order, an id list is a membership filter over those candidates.
 */
function rosterLookup(
  roster: string[],
  defaultLimit: number,
  seen: unknown[],
): (roomId: string, arg?: number | string[]) => Promise<string[]> {
  return (_roomId, arg) => {
    seen.push(arg)
    if (Array.isArray(arg)) return Promise.resolve(roster.filter((m) => arg.includes(m)))
    return Promise.resolve(roster.slice(0, arg ?? defaultLimit))
  }
}

function resolverOver(
  kind: "cleanup" | "report" | "group",
  roster: string[],
  resolved: UserMentionDTO[],
  seen: unknown[],
): ChatMentionResolverDeps {
  const none = (): Promise<string[]> => Promise.resolve([])
  return {
    resolveTargets: () => Promise.resolve(resolved),
    dmPeerOf: () => Promise.resolve(null),
    listCleanupMemberIds:
      kind === "cleanup" ? rosterLookup(roster, THREAD_SIGNAL_MEMBER_CAP, seen) : none,
    listReportChatMemberIds:
      kind === "report" ? rosterLookup(roster, REPORT_CHAT_MEMBER_SCAN_CAP, seen) : none,
    listGroupMemberIds: kind === "group" ? rosterLookup(roster, GROUP_MEMBER_SCAN_CAP, seen) : none,
  } as ChatMentionResolverDeps
}

describe("mention scope checks membership of the mentioned users, not a capped roster", () => {
  const cases = [
    { kind: "cleanup" as const, cap: THREAD_SIGNAL_MEMBER_CAP },
    { kind: "report" as const, cap: REPORT_CHAT_MEMBER_SCAN_CAP },
    { kind: "group" as const, cap: GROUP_MEMBER_SCAN_CAP },
  ]

  for (const { kind, cap } of cases) {
    it(`${kind}: a member who joined after the first ${cap} can still be mentioned`, async () => {
      const roster = memberIds(cap + 50)
      const lateJoiner = roster[cap + 10]!
      const seen: unknown[] = []
      const resolve = makeChatMentionResolver(
        resolverOver(kind, roster, [mention(lateJoiner), mention(STRANGER)], seen),
      )

      const out = await resolve({
        handles: [],
        userIds: [lateJoiner, STRANGER],
        authorUserId: AUTHOR,
        kind,
        roomId: ROOM,
      })

      expect(out.map((m) => m.id)).toEqual([lateJoiner])
      expect(seen).toEqual([[lateJoiner, STRANGER]])
    })
  }

  it("keeps the resolver's order and skips the membership lookup when nothing resolved", async () => {
    const roster = memberIds(3)
    const seen: unknown[] = []
    const ordered = [mention(roster[2]!), mention(roster[0]!)]
    const resolve = makeChatMentionResolver(resolverOver("group", roster, ordered, seen))

    const out = await resolve({
      handles: [],
      userIds: [],
      authorUserId: AUTHOR,
      kind: "group",
      roomId: ROOM,
    })
    expect(out.map((m) => m.id)).toEqual([roster[2], roster[0]])

    const none = makeChatMentionResolver(resolverOver("group", roster, [], seen))
    seen.length = 0
    await none({ handles: [], userIds: [], authorUserId: AUTHOR, kind: "group", roomId: ROOM })
    expect(seen).toEqual([])
  })
})

describe("resolveAndRecordChatMentions", () => {
  it("still returns no mentions on a lookup failure, and logs it without the message body", async () => {
    const warn = vi.fn()
    const out = await resolveAndRecordChatMentions(
      {
        resolveChatMentions: () => Promise.reject(new Error("mention table unavailable")),
        recordChatMentions: () => Promise.resolve(),
        logger: { warn },
      },
      {
        body: "hey @someone secret text",
        mentionedUserIds: [],
        authorUserId: AUTHOR,
        kind: "group",
        roomId: ROOM,
        messageId: "m-1",
      },
    )

    expect(out).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
    const [fields, msg] = warn.mock.calls[0]!
    expect(fields).toMatchObject({ messageId: "m-1", kind: "group", roomId: ROOM })
    expect(JSON.stringify(fields)).not.toContain("secret text")
    expect(msg).toMatch(/mention/)
  })
})
