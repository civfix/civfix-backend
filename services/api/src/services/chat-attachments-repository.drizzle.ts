import type { Queryable } from "../db/client.js"
import type { MediaDTO } from "@civfix/shared"
import type { PresignMedia } from "./media-presign.js"
import {
  loadServableAttachmentsFor,
  makeMessageAttachmentRepository,
  type MessageMediaColumn,
} from "./message-attachments-repository.drizzle.js"

const CHAT_MESSAGE_COLUMN: MessageMediaColumn = "chat_message_id"

export function attachChatMedia(
  sql: Queryable,
  messageId: string,
  uploadIds: string[],
  messageCreatedAt: Date,
  senderId: string,
): Promise<void> {
  return makeMessageAttachmentRepository(CHAT_MESSAGE_COLUMN).attach(
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
  return loadServableAttachmentsFor(sql, CHAT_MESSAGE_COLUMN, messageIds, presign, viewerUserId)
}
