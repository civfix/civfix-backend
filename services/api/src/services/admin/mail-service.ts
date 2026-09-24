
import { AppError } from "@civfix/shared"
import type {
  ComposeRequest,
  MailListQuery,
  MailListResponse,
  MailMessageDTO,
  MailStatsResponse,
  MailStatus,
  MailThreadDTO,
} from "@civfix/shared"
import type { ListThreadsInput, MailRepository } from "./mail-repository.drizzle.js"
import { domainOf } from "../../adapters/mail-text.js"
import { SEND_IN_FLIGHT_CONFLICT } from "./admin-report-service.js"
import type { OutboundMailService } from "./outbound-mail-service.js"

export interface MailServiceDeps {
  repo: MailRepository
  outboundMail: OutboundMailService
}

export interface MailService {
  list(query: MailListQuery): Promise<MailListResponse>
  getThread(id: string): Promise<MailThreadDTO>
  compose(input: ComposeRequest, actorId: string): Promise<MailThreadDTO>
  reply(id: string, input: { body: string }, actorId: string): Promise<MailThreadDTO>
  markRead(id: string): Promise<void>
  setStatus(id: string, status: MailStatus, actorId: string): Promise<void>
  resend(id: string, actorId: string): Promise<MailThreadDTO>
  stats(): Promise<MailStatsResponse>
}

export function makeMailService(deps: MailServiceDeps): MailService {
  const { repo, outboundMail } = deps

  async function requireThreadDTO(id: string): Promise<MailThreadDTO> {
    const dto = await repo.getThread(id)
    if (!dto) throw AppError.notFound("Mail thread not found")
    return dto
  }

  async function assertNoSendInFlight(threadId: string): Promise<void> {
    if (await repo.hasSendInFlight(threadId)) {
      throw AppError.conflict(SEND_IN_FLIGHT_CONFLICT)
    }
  }

  async function requireRecipient(
    id: string,
    noRecipientField: string,
    noRecipientMsg: string,
  ): Promise<string> {
    const record = await repo.getThreadRecord(id)
    if (!record) throw AppError.notFound("Mail thread not found")
    const toAddr = await repo.getLastOutboundRecipient(id)
    if (toAddr === null) throw AppError.validation({ [noRecipientField]: noRecipientMsg })
    return toAddr
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

    async compose(input: ComposeRequest, actorId: string): Promise<MailThreadDTO> {
      const thread = await outboundMail.compose({
        to: input.to,
        subject: input.subject,
        body: input.body,
        audit: { actorId, action: "mail.sent", meta: { to: input.to, subject: input.subject } },
      })
      return requireThreadDTO(thread.id)
    },

    async reply(id: string, input: { body: string }, actorId: string): Promise<MailThreadDTO> {
      await assertNoSendInFlight(id)
      const toAddr = await requireRecipient(
        id,
        "to",
        "No recipient address on this thread to reply to.",
      )
      await outboundMail.appendOutbound(id, {
        body: input.body,
        toAddr,
        audit: { actorId, action: "mail.replied", meta: { to: toAddr } },
      })
      await repo.settleThreadStatus({ threadId: id })
      await repo.markThreadRead(id)
      return requireThreadDTO(id)
    },

    async markRead(id: string): Promise<void> {
      const ok = await repo.markThreadRead(id)
      if (!ok) throw AppError.notFound("Mail thread not found")
    },

    async setStatus(id: string, status: MailStatus, actorId: string): Promise<void> {
      const ok = await repo.setThreadStatus(id, status, {
        actorId,
        action: "mail.status_changed",
        target: `mail:${id}`,
        meta: { status },
      })
      if (!ok) throw AppError.notFound("Mail thread not found")
    },

    async resend(id: string, actorId: string): Promise<MailThreadDTO> {
      const thread = await repo.getThreadRecord(id)
      if (!thread) throw AppError.notFound("Mail thread not found")
      await assertNoSendInFlight(id)
      const lastId = await repo.latestOutboundMessageId(id)
      const last = lastId === null ? null : await repo.getOutboundMessageForResend(lastId)
      if (!last) {
        throw AppError.validation({ id: "No outbound message on this thread to resend." })
      }
      const toAddr = last.toAddr
      if (toAddr === null || toAddr.length === 0) {
        throw AppError.validation({ to: "No recipient address on this thread to resend to." })
      }
      const subject = last.subject ?? thread.subject ?? ""
      await outboundMail.appendOutbound(id, {
        body: last.body,
        toAddr,
        ...(subject.length > 0 ? { subject } : {}),
        ...(last.html !== null ? { html: last.html } : {}),
        kind: "resend",
        audit: { actorId, action: "mail.resent", meta: { to: toAddr } },
      })
      return requireThreadDTO(id)
    },

    async stats(): Promise<MailStatsResponse> {
      return repo.stats7d()
    },
  }
}

const OURS_LOCAL_PART_RE = /^(reply|report|event)-/i

export function resolveCorrespondent(
  messages: readonly MailMessageDTO[],
  fromOutreach: string,
  replyDomain?: string,
): string | null {
  const ourDomains = new Set(
    [domainOf(fromOutreach), replyDomain ?? ""].map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0),
  )
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    const from = m.from
    if (from.length > 0 && !isOurAddress(from, fromOutreach, ourDomains)) return from
  }
  return null
}

function isOurAddress(from: string, fromOutreach: string, ourDomains: ReadonlySet<string>): boolean {
  if (addressesEqual(from, fromOutreach)) return true
  const addr = emailOf(from)
  if (addr === null) return false
  const at = addr.lastIndexOf("@")
  if (at < 0) return false
  const local = addr.slice(0, at)
  const domain = addr.slice(at + 1)
  return ourDomains.has(domain) && OURS_LOCAL_PART_RE.test(local)
}

function emailOf(from: string): string | null {
  const angled = /<([^>]+)>/.exec(from)
  const raw = (angled?.[1] ?? from).trim().toLowerCase()
  return raw.length > 0 ? raw : null
}

function addressesEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}
