import type { Queryable, Sql } from "../db/client.js"
import type { MediaDTO } from "@civfix/shared"
import type { PresignMedia } from "./media-presign.js"
import { loadReadyAttachmentsFor, makeAttachmentRepo } from "./message-attachments.drizzle.js"

export function attachChatMedia(
  sql: Queryable,
  messageId: string,
  uploadIds: string[],
): Promise<void> {
  return makeAttachmentRepo(sql as Sql, "chat_message_id").attach(sql, messageId, uploadIds)
}

export function loadChatAttachments(
  sql: Queryable,
  messageIds: string[],
  presign: PresignMedia,
): Promise<Map<string, MediaDTO[]>> {
  return loadReadyAttachmentsFor(sql, "chat_message_id", messageIds, presign)
}
