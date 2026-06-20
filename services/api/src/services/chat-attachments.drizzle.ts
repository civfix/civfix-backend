/**
 * Chat/DM message media attachments (persistence helpers shared by the cleanup chat + DM repos).
 *
 * Association model (mirrors the report-discussion attachment pipeline, but adapted to the partitioned
 * chat/dm message tables): media lives in the SHARED `media_assets` table, and a message claims its media
 * by stamping `media_assets.chat_message_id`. That column is a bare uuid (NOT a foreign key): chat_messages
 * and dm_messages are RANGE-partitioned with a composite PK(id, created_at), so there is no single-column
 * key to reference - exactly like chat_message_reactions / chat_message_mentions. One column serves BOTH
 * room kinds because a cleanup-chat id and a dm id are both globally-unique uuids, and the read is always
 * scoped to one message id, so they never collide.
 *
 *   - attachChatMedia(): on send, bind the composer's finalized upload ids to the new message. The WHERE
 *     clause is the entire ownership guard (capability-based, like discussion: knowing the unguessable
 *     uploadId is the proof): only bind an upload that is unclaimed (no report / discussion / other chat
 *     message) and linkable (status ready|validating). A foreign / already-claimed id silently matches 0
 *     rows - never an error, just fewer attachments.
 *   - loadChatAttachments(): on read, load the ready attachments for a set of message ids and presign each
 *     into a MediaDTO, grouped by message id. Only status='ready' media is served (validating/held/rejected
 *     are persisted but hidden) - this is the EXIF/GPS privacy gate (the worker strips + promotes to ready),
 *     mirroring the discussion + report read paths. Batched across ids so a history page is one query, not
 *     one per message.
 */
import type { Queryable } from "../db/client.js"
import type { MediaDTO, MediaKind, MediaStatus } from "@civfix/shared"
import type { PresignMedia } from "./media-presign.js"

/** A ready media_assets row selected for the MediaDTO projection (mirrors the discussion media view). */
interface ChatMediaRow {
  id: string
  chat_message_id: string
  kind: MediaKind
  codec: string | null
  r2_key: string
  thumb_key: string | null
  status: MediaStatus
  width: number | null
  height: number | null
}

/**
 * Bind finalized media uploads to a just-created chat/dm message. Only binds uploads that are unclaimed (no
 * report, no discussion message, no other chat message) and in a linkable status - a foreign/claimed id is
 * silently skipped (0 rows), never an error. Run inside the create transaction (pass the tx as `sql`).
 */
export async function attachChatMedia(
  sql: Queryable,
  messageId: string,
  uploadIds: string[],
): Promise<void> {
  if (uploadIds.length === 0) return
  await sql`
    UPDATE media_assets
    SET chat_message_id = ${messageId}
    WHERE upload_id IN ${sql(uploadIds)}
      AND (chat_message_id IS NULL OR chat_message_id = ${messageId})
      AND report_id IS NULL
      AND discussion_message_id IS NULL
      AND status IN ('ready', 'validating')
  `
}

/**
 * Load the presigned, status-'ready' attachments for a set of chat/dm message ids, grouped by message id
 * (created_at ASC within each message). Returns an empty map when no ids / no presigner. Only 'ready' media
 * is served (the privacy gate). The presign round-trips run concurrently but the per-message order is
 * preserved (the DB orders by created_at; we bucket in that order).
 */
export async function loadChatAttachments(
  sql: Queryable,
  messageIds: string[],
  presign: PresignMedia,
): Promise<Map<string, MediaDTO[]>> {
  const byMessage = new Map<string, MediaDTO[]>()
  if (messageIds.length === 0) return byMessage
  const rows = await sql<ChatMediaRow[]>`
    SELECT id, chat_message_id, kind, codec, r2_key, thumb_key, status, width, height
    FROM media_assets
    WHERE chat_message_id IN ${sql(messageIds)}
      AND status = 'ready'
    ORDER BY created_at ASC
  `
  // Presign every row concurrently (network round-trips), preserving the SELECT's created_at order so the
  // per-message bucketing below stays chronological.
  const projected = await Promise.all(
    rows.map(async (r) => {
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
      return { messageId: r.chat_message_id, dto }
    }),
  )
  for (const { messageId, dto } of projected) {
    const list = byMessage.get(messageId)
    if (list) list.push(dto)
    else byMessage.set(messageId, [dto])
  }
  return byMessage
}
