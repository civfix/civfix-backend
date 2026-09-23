import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { ChatMessageDTO, MediaDTO } from "@civfix/shared"
import type { Queryable } from "../../src/db/client.js"
import { neutralizeChatViewerFields } from "../../src/services/chat-viewer-fields.js"
import { userUploader } from "../../src/services/media-uploader.js"
import { loadServableAttachmentsFor } from "../../src/services/message-attachments.drizzle.js"
import { makeFakeSql } from "../helpers/fake-sql.js"

const MESSAGE = "11111111-1111-4111-8111-111111111111"

const PRESIGN = (r2Key: string) => Promise.resolve({ url: `memory://${r2Key}` })

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

async function attachmentSql(viewerUserId: string | null) {
  const fake = makeFakeSql([{ match: /FROM media_assets/, rows: [] }])
  await loadServableAttachmentsFor(
    fake.sql as unknown as Queryable,
    "chat_message_id",
    [MESSAGE],
    PRESIGN,
    viewerUserId,
  )
  return fake.statements.at(-1)!
}

describe("chat attachment reads", () => {
  it("offers the raw upload key only to the viewer who uploaded it", async () => {
    const viewer = randomUUID()
    const statement = await attachmentSql(viewer)
    const text = squash(statement.sql)

    expect(text).toMatch(
      /CASE WHEN media_assets\.uploader = \? THEN COALESCE\(media_assets\.served_key, CASE WHEN media_assets\.status = 'validating' THEN media_assets\.r2_key END\) ELSE CASE WHEN media_assets\.status = 'ready' THEN media_assets\.served_key END END AS r2_key/,
    )
    expect(text).toContain("AND (media_assets.status = 'ready' OR media_assets.uploader = ?)")
    expect(statement.values.filter((v) => v === userUploader(viewer))).toHaveLength(2)
  })

  it("gives a reader with no identity only ready served copies", async () => {
    const statement = await attachmentSql(null)

    expect(statement.values.filter((v) => v === null)).toHaveLength(2)
    expect(statement.values.filter((v) => typeof v === "string" && v.startsWith("u:"))).toEqual([])
    expect(squash(statement.sql)).toContain(
      "AND (media_assets.status = 'ready' OR media_assets.uploader = ?)",
    )
  })
})

function attachment(status: MediaDTO["status"], url: string): MediaDTO {
  return { id: randomUUID(), kind: "image", codec: null, url, status }
}

function message(attachments: MediaDTO[]): ChatMessageDTO {
  return {
    id: MESSAGE,
    body: "",
    mine: true,
    reactions: [],
    mentions: [],
    attachments,
  } as unknown as ChatMessageDTO
}

describe("the broadcast copy of a message", () => {
  it("never carries a sender-only link to an upload the worker has not published", () => {
    const ready = attachment("ready", "memory://processed/uploads/ready")
    const validating = attachment("validating", "memory://uploads/raw-original")

    const shared = neutralizeChatViewerFields(message([validating, ready]))

    expect(shared.attachments).toEqual([ready])
    expect(JSON.stringify(shared)).not.toContain("raw-original")
  })

  it("leaves a message without attachments as it was", () => {
    const shared = neutralizeChatViewerFields(message([]))

    expect(shared.attachments).toEqual([])
    expect(shared.mine).toBe(false)
  })
})
