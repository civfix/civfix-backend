import type { Queryable } from "../db/client.js"
import type { MediaDTO } from "@civfix/shared"
import type { PresignMedia } from "./media-presign.js"
import { loadServableAttachmentsFor, makeAttachmentRepo } from "./message-attachments.drizzle.js"

export function attachChatMedia(
  sql: Queryable,
  messageId: string,
  uploadIds: string[],
  messageCreatedAt: Date,
  senderId: string,
): Promise<void> {
  return makeAttachmentRepo("chat_message_id").attach(
    sql,
    messageId,
    uploadIds,
    messageCreatedAt,
    senderId,
  )
}

export function loadChatAttachments(
  sql: Queryable,
  messageIds: string[],
  presign: PresignMedia,
  viewerUserId: string | null,
): Promise<Map<string, MediaDTO[]>> {
  return loadServableAttachmentsFor(sql, "chat_message_id", messageIds, presign, viewerUserId)
}
