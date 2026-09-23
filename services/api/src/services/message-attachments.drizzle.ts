import type { Queryable } from "../db/client.js"
import type { MediaDTO, MediaKind, MediaStatus } from "@civfix/shared"
import { claimableAsAttachment } from "./media-bindings.js"
import { mapWithLimit, PRESIGN_CONCURRENCY, type PresignMedia } from "./media-presign.js"
import { servableMediaFilter, servedKeyExpr } from "./media-served-key.js"

export type MessageMediaColumn = "chat_message_id"

const ALL_COLUMNS: readonly MessageMediaColumn[] = ["chat_message_id"]

const CLAIM_GUARD_COLUMNS: readonly string[] = ["report_id", "post_id"]

export interface MessageAttachmentRepo {
  attach(
    tx: Queryable,
    messageId: string,
    uploadIds: string[],
    messageCreatedAt: Date,
  ): Promise<void>
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
  const otherCols = ALL_COLUMNS.filter((c) => c !== column)
  return {
    async attach(tx, messageId, uploadIds, messageCreatedAt) {
      if (uploadIds.length === 0) return
      const nullGuards = [...otherCols, ...CLAIM_GUARD_COLUMNS].reduce(
        (acc, c) => tx`${acc} AND ${tx(c)} IS NULL`,
        tx``,
      )
      await tx`
        UPDATE media_assets
        SET ${tx(column)} = ${messageId}, chat_message_created_at = ${messageCreatedAt}
        WHERE upload_id IN ${tx(uploadIds)}
          AND (${tx(column)} IS NULL OR ${tx(column)} = ${messageId})
          ${nullGuards}
          AND ${claimableAsAttachment(tx)}
          AND (status = 'ready' OR (status = 'validating' AND finalized_at IS NOT NULL))
      `
    },
  }
}

export async function loadServableAttachmentsFor(
  tag: Queryable,
  column: MessageMediaColumn,
  messageIds: string[],
  presign: PresignMedia,
): Promise<Map<string, MediaDTO[]>> {
  const byMessage = new Map<string, MediaDTO[]>()
  if (messageIds.length === 0) return byMessage
  const rows = await tag<MediaRow[]>`
    SELECT id, ${tag(column)} AS message_id, kind, codec,
           ${servedKeyExpr(tag, "media_assets")} AS r2_key,
           thumb_key, status, width, height
    FROM media_assets
    WHERE ${tag(column)} IN ${tag(messageIds)}
      AND ${servableMediaFilter(tag, "media_assets")}
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
