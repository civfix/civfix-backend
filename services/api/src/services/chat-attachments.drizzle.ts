import type { Queryable } from "../db/client.js"
import type { MediaDTO } from "@civfix/shared"
import type { PresignMedia } from "./media-presign.js"
import { loadServableAttachmentsFor, makeAttachmentRepo } from "./message-attachments.drizzle.js"

export function attachChatMedia(
  sql: Queryable,
  messageId: string,
  uploadIds: string[],
  messageCreatedAt: Date,
): Promise<void> {
  return makeAttachmentRepo("chat_message_id").attach(sql, messageId, uploadIds, messageCreatedAt)
}

export function loadChatAttachments(
  sql: Queryable,
  messageIds: string[],
  presign: PresignMedia,
): Promise<Map<string, MediaDTO[]>> {
  return loadServableAttachmentsFor(sql, "chat_message_id", messageIds, presign)
}
