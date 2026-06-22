/**
 * Chat/DM message media attachments (persistence helpers shared by the cleanup chat + DM repos).
 *
 * Media lives in the shared `media_assets` table; a chat/dm message claims its media by stamping
 * `media_assets.chat_message_id` — a bare uuid (NOT a foreign key): the chat/dm message tables are
 * RANGE-partitioned with a composite PK(id, created_at), so there is no single-column key to reference.
 * One column serves BOTH room kinds because a cleanup-chat id and a dm id are both globally-unique uuids,
 * and the read is always scoped to one message id, so they never collide. The read delegates to the
 * table-parameterized loader (message-attachments.drizzle.ts), which serves only status='ready' media
 * (the EXIF/GPS privacy gate) and presigns with a concurrency cap.
 */
import type { Queryable } from "../db/client.js"
import type { MediaDTO } from "@civfix/shared"
import type { PresignMedia } from "./media-presign.js"
import { loadReadyAttachmentsFor } from "./message-attachments.drizzle.js"

/**
 * Bind finalized media uploads to a just-created chat/dm message. The WHERE clause is the entire ownership
 * guard (capability-based, like discussion: knowing the unguessable uploadId is the proof): only bind an
 * upload that is unclaimed (no report / discussion / other chat message) and linkable (status
 * ready|validating). A foreign / already-claimed id silently matches 0 rows — never an error. Run inside
 * the create transaction (pass the tx as `sql`).
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

/** Load the presigned, status-'ready' attachments for a set of chat/dm message ids, grouped by id. */
export function loadChatAttachments(
  sql: Queryable,
  messageIds: string[],
  presign: PresignMedia,
): Promise<Map<string, MediaDTO[]>> {
  return loadReadyAttachmentsFor(sql, "chat_message_id", messageIds, presign)
}
