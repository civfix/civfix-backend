import { AppError, type PublishMailReplyResponse } from "@civfix/shared"
import { domainOf } from "../../adapters/inbound-mail.cf.js"
import type { MailMessageRecord, MailRepository, MailThreadRecord } from "./mail-repository.js"

export const MAIL_REPLY_NOT_FOUND = "Reply not found on this thread."
export const MAIL_REPLY_NOT_PUBLISHABLE =
  "This thread isn't linked to a report or event, so there is nowhere to publish the reply."

export interface MailReplyPublishLogger {
  warn(obj: unknown, msg?: string): void
}

export interface MailReplyPublishServiceDeps {
  repo: MailRepository
  applyEffects: (thread: MailThreadRecord, message: MailMessageRecord) => Promise<void>
  logger: MailReplyPublishLogger
}

export interface PublishMailReplyInput {
  threadId: string
  messageId: string
  actorId: string
}

export interface MailReplyPublishService {
  publish(input: PublishMailReplyInput): Promise<PublishMailReplyResponse>
}

export function makeMailReplyPublishService(
  deps: MailReplyPublishServiceDeps,
): MailReplyPublishService {
  const { repo } = deps

  async function inboundMessage(threadId: string, messageId: string): Promise<MailMessageRecord> {
    const message = await repo.findInboundMessage(threadId, messageId)
    if (message === null) throw AppError.notFound(MAIL_REPLY_NOT_FOUND)
    return message
  }

  async function approve(
    thread: MailThreadRecord,
    message: MailMessageRecord,
    actorId: string,
  ): Promise<MailMessageRecord> {
    const approved = await repo.approveWithheldReply(message.id, {
      actorId,
      action: "mail.reply_published",
      target: `mail:${thread.id}`,
      meta: {
        messageId: message.id,
        reportId: thread.reportId,
        cleanupId: thread.cleanupId,
        authVerdict: message.authVerdict,
        fromDomain: domainOf(message.fromAddr),
      },
    })
    return approved ?? inboundMessage(thread.id, message.id)
  }

  return {
    async publish({ threadId, messageId, actorId }) {
      const thread = await repo.getThreadRecord(threadId)
      if (thread === null) throw AppError.notFound("Mail thread not found")
      const message = await inboundMessage(threadId, messageId)
      if (thread.reportId === null && thread.cleanupId === null) {
        throw AppError.conflict(MAIL_REPLY_NOT_PUBLISHABLE)
      }
      if (message.effectsAppliedAt !== null) return { publication: "published" }

      const approved = message.unaffiliated ? await approve(thread, message, actorId) : message
      try {
        await deps.applyEffects(thread, approved)
      } catch (err) {
        deps.logger.warn(
          { err, threadId, messageId },
          "mail: publishing an approved reply failed (claim released; the sweep re-drives it)",
        )
      }
      const after = await inboundMessage(threadId, messageId)
      return { publication: after.effectsAppliedAt !== null ? "published" : "pending" }
    },
  }
}
