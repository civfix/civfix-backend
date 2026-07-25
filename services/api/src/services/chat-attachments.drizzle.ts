import type { Queryable } from "../db/client.js"
import type { MediaDTO } from "@civfix/shared"
import type { PresignMedia } from "./media-presign.js"
import { loadReadyAttachmentsFor, makeAttachmentRepo } from "./message-attachments.drizzle.js"

export function attachChatMedia(
  sql: Queryable,
  messageId: string,
  uploadIds: string[],
): Promise<void> {
  // The write runs on the CALLER's tag (the create/edit tx), which `attach` takes per call.
  return makeAttachmentRepo("chat_message_id").attach(sql, messageId, uploadIds)
}

export function loadChatAttachments(
  sql: Queryable,
  messageIds: string[],
  presign: PresignMedia,
): Promise<Map<string, MediaDTO[]>> {
  return loadReadyAttachmentsFor(sql, "chat_message_id", messageIds, presign)
}
