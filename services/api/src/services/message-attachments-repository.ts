import type { Queryable } from "../db/client.js"

export interface MessageAttachmentRepository {
  attach(
    tx: Queryable,
    messageId: string,
    uploadIds: string[],
    messageCreatedAt: Date,
    senderId: string,
  ): Promise<void>
}
