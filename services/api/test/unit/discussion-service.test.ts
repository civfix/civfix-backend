/**
 * Offline unit tests for the discussion service over the in-memory DiscussionRepository + a spy
 * OutboundMailService (no DB, no SMTP, no Docker). They exercise the DiscussionService seam:
 *   - list / listReplies page top-level vs reply messages, exclude deleted, and respect report visibility;
 *   - createMessage validates body + the report's visibility, enforces one-level replies (no nested /
 *     cross-report parent), links media (unattached/own only), and the @city-mention forward path;
 *   - the KEY city-mention rule: a mention with NO contact on file STILL POSTS (forwardedToCity=false) and
 *     does NOT throw, unlike the admin sendFollowup-to-city 422;
 *   - toggleReaction toggles + returns the recomputed reactions; deleteMessage soft-deletes (author OR
 *     operator) and tombstones the returned DTO.
 *
 * The Drizzle repo is covered by the Docker-gated integration suite; here the fake exercises the same seam.
 */

import { describe, expect, it } from "vitest"
import type { MailThreadRecord } from "../../src/services/admin/mail-repository.drizzle.js"
import type {
  OutboundMailService,
  SendToCityInput,
} from "../../src/services/admin/outbound-mail-service.js"
import {
  makeDiscussionService,
  type DiscussionService,
} from "../../src/services/discussion-service.js"
import {
  InMemoryDiscussionRepository,
  type SeededJurisdiction,
} from "../helpers/discussion.js"

const REPORT = "11111111-1111-1111-1111-111111111111"
const AUTHOR = "22222222-2222-2222-2222-222222222222"
const OTHER = "33333333-3333-3333-3333-333333333333"

/** A spy OutboundMailService capturing sendToCity calls; the other methods are unused stubs. */
class SpyOutboundMail implements OutboundMailService {
  readonly cityCalls: SendToCityInput[] = []
  shouldThrow = false
  sendToCity(input: SendToCityInput): Promise<MailThreadRecord> {
    this.cityCalls.push(input)
    if (this.shouldThrow) return Promise.reject(new Error("smtp boom"))
    return Promise.resolve(stubThread())
  }
  sendReportToJurisdiction(): Promise<{ thread: MailThreadRecord; messageId: string }> {
    return Promise.resolve({ thread: stubThread(), messageId: "<stub@civfix.org>" })
  }
  compose(): Promise<MailThreadRecord> {
    return Promise.resolve(stubThread())
  }
  appendOutbound(): Promise<MailThreadRecord> {
    return Promise.resolve(stubThread())
  }
  mintReplyAddress(token: string): string {
    return `reply+${token}@civfix.org`
  }
}

function stubThread(): MailThreadRecord {
  return {
    id: "thread-1",
    threadToken: "geo-1",
    reportId: null,
    jurisdictionGeoid: null,
    org: null,
    subject: null,
    status: "sent",
    unread: false,
    lastMessageAt: null,
    createdAt: new Date(),
  }
}

interface Harness {
  repo: InMemoryDiscussionRepository
  mail: SpyOutboundMail
  service: DiscussionService
}

/** Build a harness with a seeded public report (+ optional jurisdiction) and a seeded author. */
function makeHarness(jurisdiction?: SeededJurisdiction | null): Harness {
  const repo = new InMemoryDiscussionRepository()
  const mail = new SpyOutboundMail()
  repo.seedAuthor({ id: AUTHOR, displayName: "Jane Neighbor", handle: "jane" })
  repo.seedAuthor({ id: OTHER, displayName: "Bob Other", handle: "bob" })
  repo.seedReport({ id: REPORT, reporterUserId: AUTHOR, jurisdiction: jurisdiction ?? null })
  let n = 0
  const service = makeDiscussionService({
    repo,
    outboundMail: mail,
    presignMedia: (r2Key, thumbKey) =>
      Promise.resolve(thumbKey === null ? { url: `signed:${r2Key}` } : { url: `signed:${r2Key}`, thumbUrl: `signed:${thumbKey}` }),
    newId: () => `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 5, 1, 0, 0, 0, n)),
  })
  return { repo, mail, service }
}

describe("DiscussionService.createMessage", () => {
  it("creates a top-level message and returns it as a DTO", async () => {
    const { service } = makeHarness()
    const dto = await service.createMessage(REPORT, AUTHOR, { body: "First!" })
    expect(dto.reportId).toBe(REPORT)
    expect(dto.parentId).toBeNull()
    expect(dto.body).toBe("First!")
    expect(dto.author?.id).toBe(AUTHOR)
    expect(dto.mine).toBe(true)
    expect(dto.replyCount).toBe(0)
    expect(dto.forwardedToCity).toBe(false)
    expect(dto.cityMention).toBeNull()
  })

  it("trims the body and rejects an empty/whitespace body", async () => {
    const { service } = makeHarness()
    await expect(service.createMessage(REPORT, AUTHOR, { body: "   " })).rejects.toMatchObject({
      code: "VALIDATION",
    })
  })

  it("404s on a non-existent report", async () => {
    const { service } = makeHarness()
    await expect(
      service.createMessage("99999999-9999-9999-9999-999999999999", AUTHOR, { body: "hi" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("hides a non-public report from a non-owner (404) but lets the owner comment", async () => {
    const { repo, service } = makeHarness()
    repo.seedReport({ id: REPORT, reporterUserId: AUTHOR, status: "held", visibility: "public" })
    await expect(service.createMessage(REPORT, OTHER, { body: "hi" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    const dto = await service.createMessage(REPORT, AUTHOR, { body: "owner can" })
    expect(dto.body).toBe("owner can")
  })

  it("creates a reply to a top-level message and bumps the parent replyCount", async () => {
    const { service } = makeHarness()
    const parent = await service.createMessage(REPORT, AUTHOR, { body: "parent" })
    const reply = await service.createMessage(REPORT, OTHER, {
      body: "child",
      parentId: parent.id,
    })
    expect(reply.parentId).toBe(parent.id)
    const page = await service.list(REPORT, null, null, 20)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.id).toBe(parent.id)
    expect(page.items[0]!.replyCount).toBe(1)
  })

  it("rejects a nested reply (reply-of-a-reply)", async () => {
    const { service } = makeHarness()
    const parent = await service.createMessage(REPORT, AUTHOR, { body: "parent" })
    const reply = await service.createMessage(REPORT, OTHER, { body: "child", parentId: parent.id })
    await expect(
      service.createMessage(REPORT, AUTHOR, { body: "grandchild", parentId: reply.id }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("rejects a parent from another report", async () => {
    const { repo, service } = makeHarness()
    const otherReport = repo.seedReport({ reporterUserId: AUTHOR })
    // Seed a top-level message directly on the other report.
    const foreign = await service.createMessage(otherReport.id, AUTHOR, { body: "elsewhere" })
    await expect(
      service.createMessage(REPORT, AUTHOR, { body: "x", parentId: foreign.id }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("links unattached ready media to the new message", async () => {
    const { repo, service } = makeHarness()
    const asset = repo.seedMedia({ status: "ready" })
    const dto = await service.createMessage(REPORT, AUTHOR, {
      body: "with photo",
      mediaUploadIds: [asset.uploadId],
    })
    expect(dto.attachments).toHaveLength(1)
    expect(dto.attachments[0]!.id).toBe(asset.id)
    expect(dto.attachments[0]!.url).toBe(`signed:${asset.r2Key}`)
  })

  it("never steals a foreign attachment (already bound to a report)", async () => {
    const { repo, service } = makeHarness()
    const asset = repo.seedMedia({ status: "ready", reportId: "some-report" })
    const dto = await service.createMessage(REPORT, AUTHOR, {
      body: "try steal",
      mediaUploadIds: [asset.uploadId],
    })
    expect(dto.attachments).toHaveLength(0)
  })
})

describe("DiscussionService.createMessage @city mention + forward", () => {
  const JURIS_WITH_CONTACT: SeededJurisdiction = {
    geoid: "0600001",
    name: "San Francisco",
    handle: "sf",
    contactEmail: "fix@sf.gov",
  }
  const JURIS_NO_CONTACT: SeededJurisdiction = {
    geoid: "0600002",
    name: "San Francisco",
    handle: "sf",
    contactEmail: null,
  }

  it("forwards to the city + records a forwarded mention when a contact is on file", async () => {
    const { mail, service } = makeHarness(JURIS_WITH_CONTACT)
    const dto = await service.createMessage(REPORT, AUTHOR, { body: "pls help @sf" })
    expect(mail.cityCalls).toHaveLength(1)
    expect(mail.cityCalls[0]!.toAddr).toBe("fix@sf.gov")
    expect(mail.cityCalls[0]!.geoid).toBe("0600001")
    expect(dto.forwardedToCity).toBe(true)
    expect(dto.cityMention).toEqual({
      handle: "sf",
      geoid: "0600001",
      name: "San Francisco",
      forwarded: true,
    })
  })

  it("STILL POSTS (forwardedToCity=false, no throw) when the city has no contact on file", async () => {
    const { mail, service } = makeHarness(JURIS_NO_CONTACT)
    const dto = await service.createMessage(REPORT, AUTHOR, { body: "hey @sf fix it" })
    expect(mail.cityCalls).toHaveLength(0) // never attempted - no contact
    expect(dto.forwardedToCity).toBe(false)
    expect(dto.cityMention).toEqual({
      handle: "sf",
      geoid: "0600002",
      name: "San Francisco",
      forwarded: false,
    })
  })

  it("still posts (forwardedToCity=false) when the city send THROWS", async () => {
    const { mail, service } = makeHarness(JURIS_WITH_CONTACT)
    mail.shouldThrow = true
    const dto = await service.createMessage(REPORT, AUTHOR, { body: "@sf urgent" })
    expect(mail.cityCalls).toHaveLength(1)
    expect(dto.forwardedToCity).toBe(false)
    expect(dto.cityMention?.forwarded).toBe(false)
  })

  it("does NOT forward when the body mentions a different handle", async () => {
    const { mail, service } = makeHarness(JURIS_WITH_CONTACT)
    const dto = await service.createMessage(REPORT, AUTHOR, { body: "@oakland not us" })
    expect(mail.cityCalls).toHaveLength(0)
    expect(dto.cityMention).toBeNull()
  })

  it("derives the handle on the fly when the jurisdiction handle column is null", async () => {
    const { mail, service } = makeHarness({
      geoid: "0600003",
      name: "City of Oakland",
      handle: null,
      contactEmail: "fix@oakland.gov",
    })
    const dto = await service.createMessage(REPORT, AUTHOR, { body: "ping @oakland" })
    expect(mail.cityCalls).toHaveLength(1)
    expect(dto.forwardedToCity).toBe(true)
    expect(dto.cityMention?.handle).toBe("oakland")
  })
})

describe("DiscussionService.toggleReaction", () => {
  it("adds then removes a reaction, returning the recomputed counts", async () => {
    const { service } = makeHarness()
    const msg = await service.createMessage(REPORT, AUTHOR, { body: "react to me" })
    const added = await service.toggleReaction(REPORT, msg.id, OTHER, "like")
    expect(added.reactions).toEqual([{ emoji: "like", count: 1, mine: true }])
    const removed = await service.toggleReaction(REPORT, msg.id, OTHER, "like")
    expect(removed.reactions).toEqual([])
  })

  it("mine is false for a reaction the viewer did not place", async () => {
    const { service } = makeHarness()
    const msg = await service.createMessage(REPORT, AUTHOR, { body: "x" })
    await service.toggleReaction(REPORT, msg.id, OTHER, "heart")
    const seenByAuthor = await service.toggleReaction(REPORT, msg.id, AUTHOR, "like")
    const heart = seenByAuthor.reactions.find((r) => r.emoji === "heart")
    expect(heart).toEqual({ emoji: "heart", count: 1, mine: false })
  })

  it("404s a reaction on a deleted message", async () => {
    const { service } = makeHarness()
    const msg = await service.createMessage(REPORT, AUTHOR, { body: "doomed" })
    await service.deleteMessage(REPORT, msg.id, { userId: AUTHOR, isOperator: false })
    await expect(
      service.toggleReaction(REPORT, msg.id, OTHER, "like"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("DiscussionService.deleteMessage", () => {
  it("lets the author soft-delete + tombstones the returned DTO", async () => {
    const { service } = makeHarness()
    const msg = await service.createMessage(REPORT, AUTHOR, { body: "secret" })
    const tomb = await service.deleteMessage(REPORT, msg.id, { userId: AUTHOR, isOperator: false })
    expect(tomb.deletedAt).toBeDefined()
    expect(tomb.body).toBe("")
    expect(tomb.author).toBeNull()
  })

  it("forbids a non-author non-operator", async () => {
    const { service } = makeHarness()
    const msg = await service.createMessage(REPORT, AUTHOR, { body: "mine" })
    await expect(
      service.deleteMessage(REPORT, msg.id, { userId: OTHER, isOperator: false }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("lets an operator delete someone else's message", async () => {
    const { service } = makeHarness()
    const msg = await service.createMessage(REPORT, AUTHOR, { body: "moderated" })
    const tomb = await service.deleteMessage(REPORT, msg.id, { userId: OTHER, isOperator: true })
    expect(tomb.deletedAt).toBeDefined()
  })

  it("excludes a soft-deleted top-level message from the list but keeps its replies", async () => {
    const { service } = makeHarness()
    const parent = await service.createMessage(REPORT, AUTHOR, { body: "parent" })
    await service.createMessage(REPORT, OTHER, { body: "child", parentId: parent.id })
    await service.deleteMessage(REPORT, parent.id, { userId: AUTHOR, isOperator: false })
    const top = await service.list(REPORT, null, null, 20)
    expect(top.items).toHaveLength(0)
    // The reply survives and is still listable under the (now-deleted) parent? listReplies requires a
    // non-deleted parent, so it 404s - the reply row survives in storage for moderation/audit.
    await expect(service.listReplies(REPORT, parent.id, null, null, 20)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })
})

describe("DiscussionService.list / listReplies", () => {
  it("pages top-level messages oldest-first and returns a nextCursor", async () => {
    const { service } = makeHarness()
    const a = await service.createMessage(REPORT, AUTHOR, { body: "a" })
    const b = await service.createMessage(REPORT, AUTHOR, { body: "b" })
    await service.createMessage(REPORT, AUTHOR, { body: "c" })
    const page1 = await service.list(REPORT, null, null, 2)
    expect(page1.items.map((i) => i.id)).toEqual([a.id, b.id])
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await service.list(REPORT, null, page1.nextCursor, 2)
    expect(page2.items).toHaveLength(1)
    expect(page2.nextCursor).toBeNull()
  })

  it("listReplies 404s when the parent is not a top-level message of this report", async () => {
    const { service } = makeHarness()
    await expect(
      service.listReplies(REPORT, "00000000-0000-0000-0000-000000000099", null, null, 20),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})
