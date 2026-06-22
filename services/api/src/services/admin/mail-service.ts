/**
 * Admin mail service (Phase 2): the orchestration layer the mail routes call. It composes the
 * MailRepository (persistence) with the OutboundMailService (deliver + record), keeping the routes thin
 * and the whole thing unit-testable offline with the in-memory repo + FakeMailer (no DB, no Docker),
 * mirroring the Phase 1 makeXService pattern.
 *
 * It owns ONLY the read projections + the thread-lifecycle writes (mark read / set status) directly on
 * the repo; every actual SEND (compose / reply / resend) is delegated to the OutboundMailService so the
 * "deliver before recording" + reply-address minting + thread bumping live in one place. The service
 * returns the affected MailThreadDTO so the route can echo it; mutations that target a thread 404 when
 * the thread is unknown (AppError.notFound), and a reply/resend with no resolvable recipient is a 422.
 *
 * RECIPIENT RESOLUTION (reply + resend): first prefer the latest INBOUND `from` (the municipal party we
 * are corresponding with). For an OUTBOUND-ONLY thread (operator -> city composed/resent, no reply yet)
 * there is no inbound `from` and MailMessageDTO does not carry the original `to`, so we fall back to the
 * repo's getLastOutboundRecipient (the latest OUT message's stored to_addr) - M1: this is exactly the
 * recipient we already sent to, so reply/resend target it instead of 422ing. Only a thread with neither
 * an inbound correspondent NOR any outbound recipient (which should not happen for a real thread) is a
 * clean 422.
 *
 * Audit (H4): each mutation takes the operator userId and passes it down so the audit_log row
 * (mail.sent / mail.replied / mail.resent / mail.status_changed) is written IN THE SAME transaction as
 * the effect (the message insert, or the status UPDATE) by the repo - "did + recorded" is atomic and the
 * in-memory repo records it so the offline tests assert it. The deliverability mail_events rows are still
 * recorded by the OutboundMailService.
 */

import { AppError } from "@civfix/shared"
import type {
  ComposeRequest,
  MailDirection,
  MailListQuery,
  MailListResponse,
  MailMessageDTO,
  MailStatsResponse,
  MailStatus,
  MailThreadDTO,
} from "@civfix/shared"
import type { ListThreadsInput, MailRepository } from "./mail-repository.drizzle.js"
import type { OutboundMailService } from "./outbound-mail-service.js"

/** The From address civfix originates outbound mail with; used to exclude our own messages when resolving a recipient. */
export interface MailServiceDeps {
  repo: MailRepository
  outboundMail: OutboundMailService
  /** The outbound From address (MAIL_FROM_OUTREACH); a message from it is "ours", not a reply target. */
  fromOutreach: string
}

export interface MailService {
  /** The thread list (filter dir / needs-attention / geoid + search), keyset paginated. */
  list(query: MailListQuery): Promise<MailListResponse>
  /** A thread + its ordered messages, or AppError.notFound when the id is unknown. */
  getThread(id: string): Promise<MailThreadDTO>
  /** Compose a brand-new outbound thread (deliver + record + audit mail.sent in-tx), returning the DTO. */
  compose(input: ComposeRequest, actorId: string | null): Promise<MailThreadDTO>
  /** Reply to a thread: append OUT to the resolved recipient, deliver, mark replied, audit in-tx (H4). */
  reply(id: string, input: { body: string }, actorId: string | null): Promise<MailThreadDTO>
  /** Clear a thread's unread flag. AppError.notFound when the id is unknown. (benign; not audited) */
  markRead(id: string): Promise<void>
  /** Set a thread's status (audits mail.status_changed in-tx). AppError.notFound for an unknown id. */
  setStatus(id: string, status: MailStatus, actorId: string | null): Promise<void>
  /** Resend the thread's latest outbound message to the resolved recipient (deliver + record + audit). */
  resend(id: string, actorId: string | null): Promise<MailThreadDTO>
  /** Deliverability + mailbox stats over a rolling 7-day window. */
  stats(): Promise<MailStatsResponse>
}

/**
 * Construct the admin mail service. Pure wiring over the repo + the OutboundMailService; no Fastify, no
 * container, so the unit tests build it directly from the in-memory repo + a FakeMailer-backed outbound.
 */
export function makeMailService(deps: MailServiceDeps): MailService {
  const { repo, outboundMail, fromOutreach } = deps

  /** Re-read a thread as a DTO after a write; the thread is known to exist here so a null is an invariant break. */
  async function requireThreadDTO(id: string): Promise<MailThreadDTO> {
    const dto = await repo.getThread(id)
    if (!dto) throw AppError.notFound("Mail thread not found")
    return dto
  }

  /**
   * Resolve a reply/resend recipient: the latest inbound correspondent if any, else (M1) the latest
   * outbound message's stored to_addr (an outbound-only thread). Null only when neither exists.
   */
  async function resolveRecipient(
    threadId: string,
    messages: readonly MailMessageDTO[],
  ): Promise<string | null> {
    const inbound = resolveCorrespondent(messages, fromOutreach)
    if (inbound !== null) return inbound
    return repo.getLastOutboundRecipient(threadId)
  }

  /** The shared reply/resend prologue: load the thread (404 if unknown) + resolve its recipient (422 if none). */
  async function loadThreadAndRecipient(
    id: string,
    noRecipientField: string,
    noRecipientMsg: string,
  ): Promise<{ dto: MailThreadDTO; toAddr: string }> {
    const dto = await repo.getThread(id)
    if (!dto) throw AppError.notFound("Mail thread not found")
    const toAddr = await resolveRecipient(id, dto.messages)
    if (toAddr === null) throw AppError.validation({ [noRecipientField]: noRecipientMsg })
    return { dto, toAddr }
  }

  return {
    async list(query: MailListQuery): Promise<MailListResponse> {
      const input: ListThreadsInput = {
        ...(query.dir !== undefined ? { dir: query.dir } : {}),
        ...(query.filter === "attn" ? { filter: "attn" as const } : {}),
        ...(query.geoid !== undefined ? { jurisdictionGeoid: query.geoid } : {}),
        ...(query.q !== undefined ? { q: query.q } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      }
      return repo.listThreads(input)
    },

    async getThread(id: string): Promise<MailThreadDTO> {
      const dto = await repo.getThread(id)
      if (!dto) throw AppError.notFound("Mail thread not found")
      return dto
    },

    async compose(input: ComposeRequest, actorId: string | null): Promise<MailThreadDTO> {
      const thread = await outboundMail.compose({
        to: input.to,
        subject: input.subject,
        body: input.body,
        // H4: the mail.sent audit is written in the same tx as the first message insert.
        audit: { actorId, action: "mail.sent", meta: { to: input.to, subject: input.subject } },
      })
      return requireThreadDTO(thread.id)
    },

    async reply(id: string, input: { body: string }, actorId: string | null): Promise<MailThreadDTO> {
      const { toAddr } = await loadThreadAndRecipient(
        id,
        "to",
        "No recipient address on this thread to reply to.",
      )
      // H4: the mail.replied audit is written in the same tx as the OUT message insert.
      await outboundMail.appendOutbound(id, {
        body: input.body,
        toAddr,
        audit: { actorId, action: "mail.replied", meta: { to: toAddr } },
      })
      // Best-effort attention-resolve after the send (replied + read). These are two separate non-tx repo
      // writes on the already-recorded reply; a failure here leaves the (audited) reply intact but the
      // thread not flipped — a benign UI-state drift the operator can re-toggle, not a lost message.
      await repo.setThreadStatus(id, "replied")
      await repo.markThreadRead(id)
      return requireThreadDTO(id)
    },

    async markRead(id: string): Promise<void> {
      const ok = await repo.markThreadRead(id)
      if (!ok) throw AppError.notFound("Mail thread not found")
    },

    async setStatus(id: string, status: MailStatus, actorId: string | null): Promise<void> {
      // H4: the mail.status_changed audit is written in the same tx as the status UPDATE.
      const ok = await repo.setThreadStatus(id, status, {
        actorId,
        action: "mail.status_changed",
        target: `mail:${id}`,
        meta: { status },
      })
      if (!ok) throw AppError.notFound("Mail thread not found")
    },

    async resend(id: string, actorId: string | null): Promise<MailThreadDTO> {
      const { dto, toAddr } = await loadThreadAndRecipient(
        id,
        "to",
        "No recipient address on this thread to resend to.",
      )
      const last = latestOutbound(dto.messages)
      if (!last) {
        throw AppError.validation({ id: "No outbound message on this thread to resend." })
      }
      // Re-deliver the latest outbound body as a fresh OUT message (a true resend appends a new attempt so
      // the deliverability event correlates to a real message row). H4: mail.resent audited in-tx.
      await outboundMail.appendOutbound(id, {
        body: last.body,
        toAddr,
        audit: { actorId, action: "mail.resent", meta: { to: toAddr } },
      })
      return requireThreadDTO(id)
    },

    async stats(): Promise<MailStatsResponse> {
      return repo.stats7d()
    },
  }
}

/**
 * Resolve the municipal correspondent's address from a thread's messages: the `from` of the latest
 * message NOT sent by civfix (the outreach From). That is the inbound party we reply/resend to. Returns
 * null when no such address exists (e.g. an outbound-only thread that never received a reply), so the
 * caller can 422 rather than guess.
 */
export function resolveCorrespondent(
  messages: readonly MailMessageDTO[],
  fromOutreach: string,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    const from = m.from
    if (from.length > 0 && !addressesEqual(from, fromOutreach)) return from
  }
  return null
}

/** The latest OUTBOUND message in a thread (the one a resend re-delivers), or null when there is none. */
export function latestOutbound(messages: readonly MailMessageDTO[]): MailMessageDTO | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && (m.dir as MailDirection) === "out") return m
  }
  return null
}

/** Case-insensitive email address compare (sender labels may differ only in case). */
function addressesEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}
