import { describe, expect, it } from "vitest"
import type { Queryable, Sql } from "../../src/db/client.js"
import { attachChatMedia } from "../../src/services/chat-attachments.drizzle.js"
import { mediaBoundElsewhere } from "../../src/services/media-bindings.js"
import {
  makeDrizzlePostRepository,
  type CreatePostArgs,
} from "../../src/services/post-repository.drizzle.js"
import { makeFakeSql, type FakeSqlControl } from "../helpers/fake-sql.js"

const AUTHOR = "11111111-1111-4111-8111-111111111111"
const POST_ID = "22222222-2222-4222-8222-222222222222"
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333"
const UPLOAD_ID = "44444444-4444-4444-8444-444444444444"
const UNAVAILABLE = "One or more media uploads are unavailable."

function squash(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim()
}

async function renderBoundElsewhere(): Promise<string> {
  const fake = makeFakeSql([])
  await fake.sql`${mediaBoundElsewhere(fake.sql as unknown as Queryable, null)}`
  return squash(fake.statements[0]?.sql ?? "")
}

function claimWhereClause(fake: FakeSqlControl, set: RegExp): string {
  const claim = fake.statements.find((s) => set.test(s.sql))
  if (!claim) throw new Error("no media claim statement was sent")
  const text = squash(claim.sql)
  return text.slice(text.indexOf(" WHERE "))
}

function postArgs(mediaUploadIds: string[]): CreatePostArgs {
  return {
    authorId: AUTHOR,
    kind: "post",
    body: "hello",
    replyToId: null,
    repostOfId: null,
    eventId: null,
    reportId: null,
    mediaUploadIds,
    mentionedUserIds: [],
    organizationId: null,
  }
}

function postRepo(fake: FakeSqlControl) {
  return makeDrizzlePostRepository(fake.sql as unknown as Sql, {
    presignMedia: () => Promise.resolve({ url: "u" }),
    presignAvatar: () => Promise.resolve("a"),
  })
}

const POST_CLAIM = /UPDATE media_assets\s+SET post_id/

describe("post create: media claim predicate", () => {
  it("claims only unbound report-purpose uploads, checked before the row is re-purposed", async () => {
    const fake = makeFakeSql([{ match: /INSERT INTO posts/, rows: [{ id: POST_ID }] }])

    await expect(postRepo(fake).createPost(postArgs([UPLOAD_ID]))).rejects.toMatchObject({
      httpStatus: 422,
      fields: { mediaUploadIds: UNAVAILABLE },
    })

    const where = claimWhereClause(fake, POST_CLAIM)
    expect(where).toContain("purpose = 'report'")
    expect(where).toContain(`NOT (${await renderBoundElsewhere()})`)
    expect(where).toContain("post_id IS NULL AND chat_message_id IS NULL AND report_id IS NULL")
  })

  it("keeps attaching an author's fresh uploads", async () => {
    const fake = makeFakeSql([
      { match: /INSERT INTO posts/, rows: [{ id: POST_ID }] },
      { match: POST_CLAIM, rows: [{ upload_id: UPLOAD_ID }] },
    ])

    await expect(postRepo(fake).createPost(postArgs([UPLOAD_ID]))).resolves.toBe(POST_ID)
  })
})

describe("chat message attach: media claim predicate", () => {
  it("claims only unbound report-purpose uploads and keeps the same-message re-claim", async () => {
    const fake = makeFakeSql([])

    await attachChatMedia(fake.sql as unknown as Queryable, MESSAGE_ID, [UPLOAD_ID], new Date())

    const where = claimWhereClause(fake, /UPDATE media_assets\s+SET "?chat_message_id/)
    expect(where).toContain("purpose = 'report'")
    expect(where).toContain(`NOT (${await renderBoundElsewhere()})`)
    expect(where).toMatch(/\("?chat_message_id"? IS NULL OR "?chat_message_id"? = \?\)/)
  })
})
