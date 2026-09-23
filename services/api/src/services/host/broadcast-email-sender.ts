import type { BroadcastKind, DeliveryFailureKind } from "@civfix/shared"
import type { BroadcastVarValues } from "@civfix/shared/host"
import type { Mailer } from "@civfix/shared/interfaces"
import type { FastifyBaseLogger } from "fastify"
import type { CacheClient } from "../../auth/cache.js"
import { mailFailure } from "../../adapters/mail-failure.js"
import { mapWithLimit } from "../media-presign.js"
import type { BroadcastRepository } from "./broadcast-repository.js"
import type {
  BroadcastRecord,
  DeliveryClaim,
  DeliveryOutcome,
  EventBroadcastContext,
  GuestContact,
  MemberContact,
} from "./broadcast-types.js"
import { CRITICAL_BROADCAST_KINDS, MAX_DELIVERY_ATTEMPTS } from "./broadcast-types.js"
import {
  broadcastContentOf,
  eventTemplateVars,
  renderBroadcast,
  templateTextOf,
  usesVar,
  type RenderedBroadcast,
} from "./broadcast-render.js"
import { mintUnsubscribeToken, unsubscribeExpiryFrom } from "./broadcast-capability-token.js"
import { emailHashOf, type BroadcastConfig } from "./broadcast-service.js"

const DEDUPE_TTL_SEC = 24 * 60 * 60
const MS_PER_SECOND = 1000
const AUTOMATED_KINDS: ReadonlySet<BroadcastKind> = new Set<BroadcastKind>([
  "confirmation",
  "waitlist_promoted",
  "reminder",
  "event_updated",
  "event_cancelled",
  "thank_you",
])

export interface BroadcastEmailSenderDeps {
  repo: BroadcastRepository
  config: Pick<
    BroadcastConfig,
    | "apiBaseUrl"
    | "emailConcurrency"
    | "emailRatePerSec"
    | "linkAllowedHosts"
    | "mailFromEvents"
    | "unsubscribeSigningKey"
    | "webBaseUrl"
  >
  mailer: Mailer
  cache: CacheClient
  mailDomain: string
  logger?: Pick<FastifyBaseLogger, "warn">
  now: () => Date
}

export class ChunkAuthAbort extends Error {
  override readonly cause: unknown
  readonly releasedIds: readonly string[]

  constructor(cause: unknown, releasedIds: readonly string[]) {
    super("broadcast chunk aborted: the SMTP server rejected the sender")
    this.name = "ChunkAuthAbort"
    this.cause = cause
    this.releasedIds = releasedIds
  }
}

class TokenBucket {
  private tokens: number
  private lastRefillMs: number

  constructor(
    private readonly ratePerSec: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.tokens = ratePerSec
    this.lastRefillMs = now()
  }

  async take(): Promise<void> {
    for (;;) {
      const at = this.now()
      const elapsed = at - this.lastRefillMs
      if (elapsed > 0) {
        this.tokens = Math.min(
          this.ratePerSec,
          this.tokens + (elapsed / MS_PER_SECOND) * this.ratePerSec,
        )
        this.lastRefillMs = at
      }
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      await this.sleep(Math.ceil(((1 - this.tokens) / this.ratePerSec) * MS_PER_SECOND))
    }
  }
}

interface EmailChunk {
  record: BroadcastRecord
  event: EventBroadcastContext
  members: Map<string, MemberContact>
  guests: Map<string, GuestContact>
  ticketTypes: Map<string, string>
  addressHashes: Map<string, string>
  suppressedHashes: Set<string>
  bucket: TokenBucket
  critical: boolean
  replyTo: string | null
  sentAtMs: number
  shared: BroadcastVarValues
  outcomes: DeliveryOutcome[]
  releasedIds: string[]
  abortError: unknown
}

function addressKey(broadcastId: string, hash: string): string {
  return `bcast:addr:${broadcastId}:${hash}`
}

function contactOf(
  chunk: EmailChunk,
  claim: DeliveryClaim,
): MemberContact | GuestContact | undefined {
  return claim.userId !== null
    ? chunk.members.get(claim.userId)
    : chunk.guests.get(claim.guestId as string)
}

function firstNameOf(chunk: EmailChunk, claim: DeliveryClaim): string {
  return claim.userId !== null
    ? (chunk.members.get(claim.userId)?.firstName ?? "")
    : (chunk.guests.get(claim.guestId as string)?.name ?? "")
}

function listUnsubscribeHeaders(oneClickUrl: string, kind: BroadcastKind): Record<string, string> {
  const headers: Record<string, string> = {
    "List-Unsubscribe": `<${oneClickUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  }
  if (AUTOMATED_KINDS.has(kind)) headers["Auto-Submitted"] = "auto-generated"
  return headers
}

export function makeBroadcastEmailSender(deps: BroadcastEmailSenderDeps) {
  const { repo, config } = deps

  async function releaseAddress(broadcastId: string, hash: string): Promise<void> {
    const key = addressKey(broadcastId, hash)
    try {
      await deps.cache.del(key)
      await deps.cache.del(`${key}:owner`)
    } catch (err) {
      deps.logger?.warn(
        { err },
        "broadcast: address dedupe release failed; a retry of this row may be skipped",
      )
    }
  }

  async function claimAddress(
    broadcastId: string,
    hash: string,
    deliveryId: string,
  ): Promise<boolean> {
    const key = addressKey(broadcastId, hash)
    try {
      const held = await deps.cache.incr(key, DEDUPE_TTL_SEC)
      if (held === 1) {
        await deps.cache.set(`${key}:owner`, deliveryId, DEDUPE_TTL_SEC)
        return true
      }
      return (await deps.cache.get(`${key}:owner`)) === deliveryId
    } catch (err) {
      deps.logger?.warn(
        { err },
        "broadcast: address dedupe unavailable; sending anyway (a duplicate beats a silence)",
      )
      return true
    }
  }

  function unsubscribeLinks(
    chunk: EmailChunk,
    claim: DeliveryClaim,
    subjectId: string,
  ): { unsubscribeUrl: string; oneClickUrl: string } {
    const token = encodeURIComponent(
      mintUnsubscribeToken(
        {
          subjectKind: claim.userId !== null ? "user" : "guest",
          subjectId,
          cleanupId: chunk.record.cleanupId,
          expiresAtMs: unsubscribeExpiryFrom(chunk.sentAtMs),
        },
        config.unsubscribeSigningKey,
      ),
    )
    return {
      unsubscribeUrl: `${config.webBaseUrl}/unsubscribe?t=${token}`,
      oneClickUrl: `${config.apiBaseUrl}/v1/broadcasts/unsubscribe?t=${token}`,
    }
  }

  function renderFor(
    chunk: EmailChunk,
    claim: DeliveryClaim,
    subjectId: string,
    unsubscribeUrl: string,
  ): RenderedBroadcast {
    return renderBroadcast(broadcastContentOf(chunk.record), {
      eventTitle: chunk.event.title,
      vars: {
        ...chunk.shared,
        first_name: firstNameOf(chunk, claim),
        ticket_type: chunk.ticketTypes.get(subjectId) ?? "",
      },
      unsubscribeUrl,
      replyTo: chunk.replyTo,
      critical: chunk.critical,
      allowedLinkHosts: config.linkAllowedHosts,
    })
  }

  function holdForRetry(chunk: EmailChunk, claim: DeliveryClaim): void {
    chunk.outcomes.push({ id: claim.id, status: "pending" })
    chunk.releasedIds.push(claim.id)
  }

  /** Null means the claim's outcome is already recorded and nothing may be mailed for it. */
  async function screen(
    chunk: EmailChunk,
    claim: DeliveryClaim,
  ): Promise<{ email: string; hash: string } | null> {
    const contact = contactOf(chunk, claim)
    if (contact === undefined) {
      chunk.outcomes.push({
        id: claim.id,
        status: "suppressed",
        suppressionReason: claim.userId !== null ? "deleted_user" : "contact_scrubbed",
      })
      return null
    }
    const email = contact.email
    if (email === null || email.length === 0) {
      chunk.outcomes.push({ id: claim.id, status: "suppressed", suppressionReason: "no_contact" })
      return null
    }
    const hash = chunk.addressHashes.get(claim.id) ?? emailHashOf(email)
    if (chunk.suppressedHashes.has(hash)) {
      chunk.outcomes.push({
        id: claim.id,
        status: "suppressed",
        suppressionReason: "bounce_suppressed",
      })
      return null
    }
    if (!(await claimAddress(chunk.record.id, hash, claim.id))) {
      chunk.outcomes.push({ id: claim.id, status: "skipped" })
      return null
    }
    return { email, hash }
  }

  async function recordSendFailure(
    chunk: EmailChunk,
    claim: DeliveryClaim,
    hash: string,
    err: unknown,
  ): Promise<void> {
    const failure = mailFailure(err)
    deps.logger?.warn(
      {
        evt: "broadcast.failed",
        deliveryId: claim.id,
        failureKind: failure.kind,
        senderRejected: failure.senderRejected,
      },
      "broadcast email send failed",
    )
    if (failure.kind === "auth") {
      chunk.abortError = err
      await releaseAddress(chunk.record.id, hash)
      holdForRetry(chunk, claim)
      return
    }
    if (failure.kind === "permanent") {
      await repo.suppressEmail(hash, "hard_bounce").catch((suppressErr: unknown) => {
        deps.logger?.warn(
          { err: suppressErr, deliveryId: claim.id },
          "broadcast: hard-bounce suppression write failed; the address may be mailed again",
        )
      })
      chunk.outcomes.push({ id: claim.id, status: "failed", failureKind: "permanent" })
      return
    }
    if (failure.kind === "transient" && claim.attempts < MAX_DELIVERY_ATTEMPTS) {
      await releaseAddress(chunk.record.id, hash)
      chunk.outcomes.push({ id: claim.id, status: "pending" })
      return
    }
    chunk.outcomes.push({
      id: claim.id,
      status: "failed",
      failureKind: failure.kind as DeliveryFailureKind,
    })
  }

  async function deliver(chunk: EmailChunk, claim: DeliveryClaim): Promise<void> {
    if (chunk.abortError !== null) {
      holdForRetry(chunk, claim)
      return
    }
    const address = await screen(chunk, claim)
    if (address === null) return
    const subjectId = (claim.userId ?? claim.guestId) as string
    const { unsubscribeUrl, oneClickUrl } = unsubscribeLinks(chunk, claim, subjectId)
    const rendered = renderFor(chunk, claim, subjectId, unsubscribeUrl)
    const headers = listUnsubscribeHeaders(oneClickUrl, chunk.record.kind)

    await chunk.bucket.take()
    try {
      const sent = await deps.mailer.sendOutbound({
        from: config.mailFromEvents,
        to: address.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        messageId: `<bcast-${claim.id}@${deps.mailDomain}>`,
        headers,
        ...(chunk.replyTo !== null ? { replyTo: chunk.replyTo } : {}),
      })
      chunk.outcomes.push({
        id: claim.id,
        status: "sent",
        sentAt: deps.now(),
        ...(sent.messageId !== undefined ? { providerMessageId: sent.messageId } : {}),
      })
    } catch (err) {
      await recordSendFailure(chunk, claim, address.hash, err)
    }
  }

  async function runEmail(
    record: BroadcastRecord,
    event: EventBroadcastContext,
    claims: readonly DeliveryClaim[],
    outcomes: DeliveryOutcome[],
  ): Promise<void> {
    const relevant = claims.filter((c) => c.channel === "email")
    if (relevant.length === 0) return
    const memberIds = relevant.filter((c) => c.userId !== null).map((c) => c.userId as string)
    const guestIds = relevant.filter((c) => c.guestId !== null).map((c) => c.guestId as string)
    const [members, guests, ticketTypes] = await Promise.all([
      repo.memberContacts(memberIds),
      repo.guestContacts(guestIds),
      usesVar(templateTextOf(record), "ticket_type")
        ? repo.ticketTypeNames({ cleanupId: record.cleanupId, userIds: memberIds, guestIds })
        : Promise.resolve(new Map<string, string>()),
    ])
    const addressHashes = new Map<string, string>()
    for (const claim of relevant) {
      const contact =
        claim.userId !== null ? members.get(claim.userId) : guests.get(claim.guestId as string)
      const email = contact?.email
      if (email == null || email.length === 0) continue
      addressHashes.set(claim.id, emailHashOf(email))
    }
    const suppressedHashes = await repo.suppressedEmailHashes([...addressHashes.values()])

    const chunk: EmailChunk = {
      record,
      event,
      members,
      guests,
      ticketTypes,
      addressHashes,
      suppressedHashes,
      bucket: new TokenBucket(config.emailRatePerSec),
      critical: CRITICAL_BROADCAST_KINDS.has(record.kind),
      replyTo: event.replyToVerified && event.replyTo ? event.replyTo : null,
      sentAtMs: deps.now().getTime(),
      shared: eventTemplateVars(event, config.webBaseUrl),
      outcomes,
      releasedIds: [],
      abortError: null,
    }
    await mapWithLimit([...relevant], config.emailConcurrency, (claim) => deliver(chunk, claim))

    if (chunk.abortError !== null) throw new ChunkAuthAbort(chunk.abortError, chunk.releasedIds)
  }

  return { runEmail }
}
