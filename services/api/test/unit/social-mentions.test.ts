/**
 * Offline unit tests for the USER @-mention resolution helpers in social-repository.drizzle.ts
 * (resolveHandles / resolveUserIdsToMentions / resolveMentionTargets) and the discussion service's
 * mention persist + projection path.
 *
 * The DB-touching helpers are exercised against a MINIMAL fake postgres-js tag: a callable that records the
 * interpolated values and returns canned rows for the one SELECT each helper runs (plus a no-op `sql(array)`
 * fragment for the IN list). This keeps the projection (row -> UserMentionDTO), the self/empty short-circuit,
 * and the de-dupe-by-id rules unit-tested without Postgres; the real SQL is covered by the pg integration
 * suite. The discussion mention case uses the in-memory DiscussionRepository + an injected resolver/notify
 * spy, faithful to the wiring the route performs.
 */

import { describe, expect, it } from "vitest"
import type { Sql } from "../../src/db/client.js"
import {
  resolveHandles,
  resolveUserIdsToMentions,
  resolveMentionTargets,
} from "../../src/services/social-repository.drizzle.js"
import {
  makeDiscussionService,
  type DiscussionMentionNotifyInput,
} from "../../src/services/discussion-service.js"
import { InMemoryDiscussionRepository } from "../helpers/discussion.js"
import type { UserMentionDTO } from "@civfix/shared"
import type {
  OutboundMailService,
  SendToCityInput,
} from "../../src/services/admin/outbound-mail-service.js"
import type { MailThreadRecord } from "../../src/services/admin/mail-repository.drizzle.js"

const REPORT = "11111111-1111-1111-1111-111111111111"
const AUTHOR = "22222222-2222-2222-2222-222222222222"
const ALICE = "44444444-4444-4444-4444-444444444444"
const BOB = "55555555-5555-5555-5555-555555555555"

/**
 * A minimal callable postgres-js tag stub: every tagged-template invocation resolves to `rows`; an `sql(arr)`
 * call (the IN-list helper) returns a benign fragment. Cast to Sql for the helpers under test (they only run
 * one SELECT + one IN-list interpolation each).
 */
function fakeSql(rows: unknown[]): Sql {
  const tag = (() => Promise.resolve(rows)) as unknown as Sql
  // The helpers also call sql(array) for the IN list; make that callable too without altering `rows`.
  return new Proxy(tag, {
    apply: (target, _thisArg, args) => {
      // sql`...` tagged-template call → array-of-strings first arg; return the rows promise.
      if (Array.isArray(args[0]) && "raw" in (args[0] as object)) return Promise.resolve(rows)
      // sql(array) IN-list helper → return a harmless fragment placeholder.
      return { __fragment: true }
    },
  }) as Sql
}

describe("resolveHandles", () => {
  it("short-circuits to [] on empty input (no DB call)", async () => {
    const result = await resolveHandles(null as unknown as Sql, [], AUTHOR)
    expect(result).toEqual([])
  })

  it("projects rows into UserMentionDTO", async () => {
    const sql = fakeSql([
      { id: ALICE, handle: "alice", display_name: "Alice A" },
      { id: BOB, handle: "bob", display_name: "Bob B" },
    ])
    const result = await resolveHandles(sql, ["alice", "bob"], AUTHOR)
    expect(result).toEqual([
      { id: ALICE, handle: "alice", displayName: "Alice A" },
      { id: BOB, handle: "bob", displayName: "Bob B" },
    ])
  })
})

describe("resolveUserIdsToMentions", () => {
  it("short-circuits to [] on empty input", async () => {
    expect(await resolveUserIdsToMentions(null as unknown as Sql, [], AUTHOR)).toEqual([])
  })

  it("drops non-UUID ids and projects the rest", async () => {
    const sql = fakeSql([{ id: ALICE, handle: "alice", display_name: "Alice A" }])
    const result = await resolveUserIdsToMentions(sql, ["not-a-uuid", ALICE], AUTHOR)
    expect(result).toEqual([{ id: ALICE, handle: "alice", displayName: "Alice A" }])
  })

  it("short-circuits when every id is malformed (no DB call)", async () => {
    expect(await resolveUserIdsToMentions(null as unknown as Sql, ["nope"], AUTHOR)).toEqual([])
  })
})

describe("resolveMentionTargets", () => {
  it("de-dupes a user resolved by BOTH handle and id (handle wins order)", async () => {
    // Both arms return Alice (same id); the combined set must contain her ONCE.
    const sql = fakeSql([{ id: ALICE, handle: "alice", display_name: "Alice A" }])
    const result = await resolveMentionTargets(sql, {
      handles: ["alice"],
      userIds: [ALICE],
      authorUserId: AUTHOR,
    })
    expect(result).toEqual([{ id: ALICE, handle: "alice", displayName: "Alice A" }])
  })
})

// ---------------------------------------------------------------------------
// Discussion mention persist + projection
// ---------------------------------------------------------------------------

class SpyOutboundMail implements OutboundMailService {
  sendToCity(_input: SendToCityInput): Promise<MailThreadRecord> {
    return Promise.resolve(stubThread())
  }
  sendReportToJurisdiction(): Promise<{ thread: MailThreadRecord; messageId: string }> {
    return Promise.resolve({ thread: stubThread(), messageId: "<stub@civfix.org>" })
  }
  sendEventToJurisdiction(): Promise<{ thread: MailThreadRecord; messageId: string }> {
    return Promise.resolve({ thread: stubThread(), messageId: "<stub@civfix.org>" })
  }
  compose(): Promise<MailThreadRecord> {
    return Promise.resolve(stubThread())
  }
  appendOutbound(): Promise<MailThreadRecord> {
    return Promise.resolve(stubThread())
  }
}
function stubThread(): MailThreadRecord {
  return {
    id: "thread-1",
    threadToken: "geo-1",
    reportId: null,
    cleanupId: null,
    jurisdictionGeoid: null,
    org: null,
    subject: null,
    status: "sent",
    unread: false,
    lastMessageAt: null,
    createdAt: new Date(),
  }
}

describe("DiscussionService user @-mentions", () => {
  function harness() {
    const repo = new InMemoryDiscussionRepository()
    // Seed the author + the mentionable users (the fake resolves mentioned users from this authors store).
    repo.seedAuthor({ id: AUTHOR, displayName: "Author", handle: "author" })
    repo.seedAuthor({ id: ALICE, displayName: "Alice A", handle: "alice" })
    repo.seedAuthor({ id: BOB, displayName: "Bob B", handle: "bob" })
    repo.seedReport({ id: REPORT, reporterUserId: AUTHOR, jurisdiction: null })
    const directory: Record<string, UserMentionDTO> = {
      alice: { id: ALICE, handle: "alice", displayName: "Alice A" },
      bob: { id: BOB, handle: "bob", displayName: "Bob B" },
    }
    const notified: DiscussionMentionNotifyInput[] = []
    let n = 0
    const service = makeDiscussionService({
      repo,
      outboundMail: new SpyOutboundMail(),
      presignMedia: (r2Key) => Promise.resolve({ url: `signed:${r2Key}` }),
      // Resolve @handles + ids against the directory, excluding the author (self).
      resolveMentions: ({ handles, userIds, authorUserId }) => {
        const out: UserMentionDTO[] = []
        const seen = new Set<string>()
        for (const h of handles) {
          const u = directory[h.toLowerCase()]
          if (u && u.id !== authorUserId && !seen.has(u.id)) {
            seen.add(u.id)
            out.push(u)
          }
        }
        for (const id of userIds) {
          const u = Object.values(directory).find((d) => d.id === id)
          if (u && u.id !== authorUserId && !seen.has(u.id)) {
            seen.add(u.id)
            out.push(u)
          }
        }
        return Promise.resolve(out)
      },
      notifyMention: (input) => {
        notified.push(input)
      },
      newId: () => `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`,
      now: () => new Date(Date.UTC(2026, 5, 1, 0, 0, 0, n)),
    })
    return { repo, service, notified }
  }

  it("parses @handles, persists mention rows, projects them onto the DTO, and notifies each", async () => {
    const { repo, service, notified } = harness()
    const dto = await service.createMessage(REPORT, AUTHOR, { body: "cc @alice and @bob, thanks" })
    expect(dto.mentions.map((m) => m.id).sort()).toEqual([ALICE, BOB].sort())
    // Persisted to the user-mention store.
    expect(repo.userMentions.filter((x) => x.messageId === dto.id).map((x) => x.mentionedUserId).sort()).toEqual(
      [ALICE, BOB].sort(),
    )
    // One notify per mentioned user (author excluded).
    expect(notified.map((x) => x.mentionedUserId).sort()).toEqual([ALICE, BOB].sort())
    expect(notified.every((x) => x.actorUserId === AUTHOR && x.reportId === REPORT)).toBe(true)
  })

  it("does not notify the author even when self-@mentioned", async () => {
    const { service, notified } = harness()
    const dto = await service.createMessage(REPORT, AUTHOR, { body: "note to self @author @alice" })
    // The resolver excludes self, so only Alice is a mention.
    expect(dto.mentions.map((m) => m.id)).toEqual([ALICE])
    expect(notified.map((x) => x.mentionedUserId)).toEqual([ALICE])
  })

  it("combines explicit mentionedUserIds with parsed handles (de-duped)", async () => {
    const { service } = harness()
    const dto = await service.createMessage(REPORT, AUTHOR, {
      body: "@alice",
      mentionedUserIds: [ALICE, BOB],
    })
    expect(dto.mentions.map((m) => m.id).sort()).toEqual([ALICE, BOB].sort())
  })

  it("REPLACES the mention set on edit (dropping an @handle drops its row)", async () => {
    const { repo, service } = harness()
    const dto = await service.createMessage(REPORT, AUTHOR, { body: "@alice @bob" })
    const edited = await service.editMessage(REPORT, dto.id, AUTHOR, { body: "only @alice now" })
    expect(edited.mentions.map((m) => m.id)).toEqual([ALICE])
    expect(
      repo.userMentions.filter((x) => x.messageId === dto.id).map((x) => x.mentionedUserId),
    ).toEqual([ALICE])
  })

  it("records no mentions when the body names no one", async () => {
    const { repo, service, notified } = harness()
    const dto = await service.createMessage(REPORT, AUTHOR, { body: "just a plain comment" })
    expect(dto.mentions).toEqual([])
    expect(repo.userMentions.filter((x) => x.messageId === dto.id)).toEqual([])
    expect(notified).toEqual([])
  })

  it("blanks mentions on a tombstoned (soft-deleted) message", async () => {
    const { service } = harness()
    const dto = await service.createMessage(REPORT, AUTHOR, { body: "@alice" })
    const removed = await service.deleteMessage(REPORT, dto.id, { userId: AUTHOR, isOperator: false })
    expect(removed.mentions).toEqual([])
  })
})
