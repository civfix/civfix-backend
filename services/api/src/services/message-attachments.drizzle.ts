import type { Queryable } from "../db/client.js"
import type { MediaDTO, MediaKind, MediaStatus } from "@civfix/shared"
import { mapWithLimit, PRESIGN_CONCURRENCY, type PresignMedia } from "./media-presign.js"

// Message media lives in the shared `media_assets` table; a message claims its media by stamping one of
// the per-stack columns below. Those columns are bare uuids (NOT foreign keys): the chat/dm message tables
// are RANGE-partitioned with a composite PK(id, created_at), so there is no single-column key to reference.
// One column per stack; the read is always scoped to one message id (globally-unique uuid), so they never
// collide. The attach guard requires every OTHER stack column to be NULL so an upload claims exactly once.
export type MessageMediaColumn = "chat_message_id" | "discussion_message_id"

const ALL_COLUMNS: readonly MessageMediaColumn[] = ["chat_message_id", "discussion_message_id"]

// Only the write side rides the repo object (chat-attachments.drizzle binds `attach`); every reader calls
// the standalone loadReadyAttachmentsFor below with its own tag, so there is no repo-shaped load method.
export interface MessageAttachmentRepo {
  attach(tx: Queryable, messageId: string, uploadIds: string[]): Promise<void>
}

interface MediaRow {
  id: string
  message_id: string
  kind: MediaKind
  codec: string | null
  r2_key: string
  thumb_key: string | null
  status: MediaStatus
  width: number | null
  height: number | null
}

export function makeAttachmentRepo(column: MessageMediaColumn): MessageAttachmentRepo {
  // The siblings that must be NULL for an upload to be claimable here: every message-media column except
  // this one, plus report_id (a report attachment is never re-bindable to a message).
  const otherCols = ALL_COLUMNS.filter((c) => c !== column)
  return {
    async attach(tx, messageId, uploadIds) {
      if (uploadIds.length === 0) return
      // The WHERE clause is the entire ownership guard (capability-based: knowing the unguessable uploadId
      // is the proof). A foreign / already-claimed id silently matches 0 rows — never an error.
      const nullGuards = [...otherCols, "report_id"].reduce(
        (acc, c) => tx`${acc} AND ${tx(c)} IS NULL`,
        tx``,
      )
      await tx`
        UPDATE media_assets
        SET ${tx(column)} = ${messageId}
        WHERE upload_id IN ${tx(uploadIds)}
          AND (${tx(column)} IS NULL OR ${tx(column)} = ${messageId})
          ${nullGuards}
          AND status IN ('ready', 'validating')
      `
    },
  }
}

// Standalone batched loader so a repo can pass its own transaction/tag. Only status='ready' media is
// served (validating/held/rejected are persisted but hidden) — this is the EXIF/GPS privacy gate (the
// worker strips + promotes to ready). The presign round-trips run with a concurrency cap; the SELECT's
// created_at order is preserved so each message's bucket stays chronological.
export async function loadReadyAttachmentsFor(
  tag: Queryable,
  column: MessageMediaColumn,
  messageIds: string[],
  presign: PresignMedia,
): Promise<Map<string, MediaDTO[]>> {
  const byMessage = new Map<string, MediaDTO[]>()
  if (messageIds.length === 0) return byMessage
  const rows = await tag<MediaRow[]>`
    SELECT id, ${tag(column)} AS message_id, kind, codec, r2_key, thumb_key, status, width, height
    FROM media_assets
    WHERE ${tag(column)} IN ${tag(messageIds)}
      AND status = 'ready'
    ORDER BY created_at ASC
  `
  const projected = await mapWithLimit(rows, PRESIGN_CONCURRENCY, async (r) => {
    const { url, thumbUrl } = await presign(r.r2_key, r.thumb_key)
    const dto: MediaDTO = {
      id: r.id,
      kind: r.kind,
      codec: r.codec,
      url,
      ...(thumbUrl !== undefined ? { thumbUrl } : {}),
      width: r.width,
      height: r.height,
      status: r.status,
    }
    return { messageId: r.message_id, dto }
  })
  for (const { messageId, dto } of projected) {
    const list = byMessage.get(messageId)
    if (list) list.push(dto)
    else byMessage.set(messageId, [dto])
  }
  return byMessage
}
