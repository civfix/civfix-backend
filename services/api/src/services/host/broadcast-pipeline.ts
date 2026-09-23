import { ANNOUNCEMENT_BROADCAST_KIND } from "@civfix/shared"
import type { BroadcastKind, DeliveryFailureKind, NotificationType } from "@civfix/shared"
import type { BroadcastVarValues } from "@civfix/shared/host"
import type { Mailer } from "@civfix/shared/interfaces"
import type { FastifyBaseLogger } from "fastify"
import type { CacheClient } from "../../auth/cache.js"
import { mailFailure } from "../../adapters/mail-failure.js"
import { isWithinQuietHours, pushGateAllows, type PushGateMode } from "../notification-helpers.js"
import type { NotificationService } from "../notification-service.js"
import { mapWithLimit } from "../media-presign.js"
import { makeInsightsGeneration } from "./host-analytics-cache.js"
import type { BroadcastRepository } from "./broadcast-repository.js"
import type {
  BroadcastRecord,
  BroadcastRecipientKind,
  DeliveryClaim,
  DeliveryOutcome,
  DeliveryRowInput,
  EventBroadcastContext,
} from "./broadcast-types.js"
import { CRITICAL_BROADCAST_KINDS, HOST_COMPOSED_BROADCAST_KINDS } from "./broadcast-types.js"
import {
  eventManageUrl,
  eventPath,
  formatEventWhen,
  renderBroadcast,
  type RenderedBroadcast,
} from "./broadcast-render.js"
import { mintUnsubscribeToken, unsubscribeExpiryFrom } from "./broadcast-capability-token.js"
import {
  AUDIENCE_MAX_PAGES,
  AUDIENCE_PAGE_SIZE,
  BroadcastCapError,
  LAST_UUID,
  emailHashOf,
  type BroadcastConfig,
  type BroadcastService,
} from "./broadcast-service.js"

export const CHUNK_STALE_MS = 10 * 60 * 1000
export const SENDING_STALE_MS = 5 * 60 * 1000
export const MAX_DELIVERY_ATTEMPTS = 3
export const AUTH_ABORT_BACKOFF_SEC = [60, 300, 900] as const
export const CRITICAL_KINDS = CRITICAL_BROADCAST_KINDS
export const AUTOMATED_KINDS = new Set([
  "confirmation",
  "waitlist_promoted",
  "reminder",
  "event_updated",
  "event_cancelled",
  "thank_you",
])

export const KIND_NOTIFICATION_TYPE: Record<BroadcastKind, NotificationType> = {
  host_broadcast: "event_broadcast",
  thank_you: "event_broadcast",
  reminder: "cleanup_reminder",
  event_updated: "system",
  event_cancelled: "cleanup_cancelled",
  confirmation: "system",
  waitlist_promoted: "system",
  announcement: "event_broadcast",
}

export const BUDGETED_KINDS: ReadonlySet<BroadcastKind> = new Set<BroadcastKind>([
  "host_broadcast",
  ANNOUNCEMENT_BROADCAST_KIND,
])

export function announcementPath(cleanupId: string, announcementId: string): string {
  return `/cleanups/${cleanupId}/announcements/${announcementId}`
}

export const PER_RECIPIENT_VARS = ["first_name", "ticket_type"] as const

export interface BroadcastPipelineDeps {
  repo: BroadcastRepository
  service: BroadcastService
  notifications: NotificationService
  mailer: Mailer
  cache: CacheClient
  config: BroadcastConfig
  mailDomain: string
  enqueueChunk: (
    broadcastId: string,
    chunkNo: number,
    opts?: { startAfterSec?: number; authRetry?: number },
  ) => Promise<void>
  audit: (
    action: string,
    actorId: string | null,
    target: string,
    meta: Record<string, unknown>,
  ) => Promise<void>
  logger?: Pick<FastifyBaseLogger, "info" | "warn" | "error">
  now?: () => Date
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

export class TokenBucket {
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
        this.tokens = Math.min(this.ratePerSec, this.tokens + (elapsed / 1000) * this.ratePerSec)
        this.lastRefillMs = at
      }
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      await this.sleep(Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000))
    }
  }
}

export interface PlanOutcome {
  kind: "planned" | "skipped" | "killed" | "org_suspended" | "too_many" | "over_budget" | "empty"
  recipients?: number
  chunks?: number
}

export function notificationLink(
  record: Pick<BroadcastRecord, "id" | "kind" | "cleanupId">,
  event: Pick<EventBroadcastContext, "pageSlug">,
): string {
  return record.kind === ANNOUNCEMENT_BROADCAST_KIND
    ? announcementPath(record.cleanupId, record.id)
    : eventPath(event.pageSlug, record.cleanupId)
}

export function usesVar(text: string, name: string): boolean {
  return text.includes(`{${name}}`)
}

export function usesPerRecipientVar(text: string): boolean {
  return PER_RECIPIENT_VARS.some((name) => usesVar(text, name))
}

export function makeBroadcastPipeline(deps: BroadcastPipelineDeps) {
  const now = deps.now ?? (() => new Date())
  const { repo, config } = deps
  const insights = makeInsightsGeneration({
    cache: deps.cache,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  })

  async function killed(record: BroadcastRecord): Promise<boolean> {
    if (config.killSwitch) return true
    if (record.createdBy === null) return false
    try {
      const state = await repo.hostMessagingState(record.createdBy)
      return state === null || state.suspended
    } catch (err) {
      deps.logger?.warn(
        { err, broadcastId: record.id },
        "broadcast: kill-switch read failed; treating as suspended (fail closed)",
      )
      return true
    }
  }

  async function killBroadcast(record: BroadcastRecord, reason: string): Promise<void> {
    const suppressed = await repo.suppressRemaining(record.id, "kill_switch")
    await repo.transition(record.id, ["draft", "scheduled", "sending"], "cancelled", {
      finishedAt: now(),
    })
    await repo.refreshCounts(record.id)
    await insights.bumpInsightsGeneration(record.cleanupId)
    await deps.audit("event.broadcast_killed", record.createdBy, `broadcast:${record.id}`, {
      cleanupId: record.cleanupId,
      kind: record.kind,
      reason,
      suppressed,
    })
    deps.logger?.warn(
      { evt: "broadcast.killed", broadcastId: record.id, cleanupId: record.cleanupId, suppressed },
      "broadcast killed",
    )
  }

  /**
   * DECISIONS §32: an operator-suspended organization's events send no host-composed message, and a
   * release or a queued plan is a send just as much as the compose-time call was. Critical automated
   * notices (a cancellation, a changed time) stay deliverable: attendees must still hear about them.
   */
  async function organizationSuspendedFor(record: BroadcastRecord): Promise<boolean> {
    if (!HOST_COMPOSED_BROADCAST_KINDS.has(record.kind)) return false
    const event = await repo.eventContext(record.cleanupId)
    return event?.organizationSuspended === true
  }

  async function failForSuspendedOrganization(
    record: BroadcastRecord,
    from: "scheduled" | "sending",
    at: Date,
  ): Promise<boolean> {
    const moved = await repo.transition(record.id, [from], "failed", { finishedAt: at })
    if (moved === null) return false
    await repo.suppressRemaining(record.id, "kill_switch")
    await repo.refreshCounts(record.id)
    await insights.bumpInsightsGeneration(record.cleanupId)
    deps.logger?.warn(
      {
        evt: "broadcast.failed",
        broadcastId: record.id,
        cleanupId: record.cleanupId,
        reason: "org_suspended",
      },
      "broadcast refused: the event's organization is suspended",
    )
    return true
  }

  async function plan(broadcastId: string): Promise<PlanOutcome> {
    const record = await repo.findById(broadcastId)
    if (record === null || record.status !== "sending") return { kind: "skipped" }
    if (await killed(record)) {
      await killBroadcast(record, "kill_switch")
      return { kind: "killed" }
    }
    if (await organizationSuspendedFor(record)) {
      const failed = await failForSuspendedOrganization(record, "sending", now())
      return { kind: failed ? "org_suspended" : "skipped" }
    }

    const segment = record.segment ?? { kind: "all_registered" as const }
    const memberIds: string[] = []
    const guestIds: string[] = []
    let afterMember: string | null = null
    let afterGuest: string | null = null
    let memberDone = false
    let guestDone = false

    for (let page = 0; page < AUDIENCE_MAX_PAGES; page += 1) {
      const result = await repo.audiencePage({
        cleanupId: record.cleanupId,
        segment,
        kind: record.kind,
        afterMember: memberDone ? LAST_UUID : afterMember,
        afterGuest: guestDone ? LAST_UUID : afterGuest,
        limit: AUDIENCE_PAGE_SIZE,
      })
      memberIds.push(...result.members)
      guestIds.push(...result.guests)
      if (result.members.length < AUDIENCE_PAGE_SIZE) memberDone = true
      else afterMember = result.members.at(-1) ?? afterMember
      if (result.guests.length < AUDIENCE_PAGE_SIZE) guestDone = true
      else afterGuest = result.guests.at(-1) ?? afterGuest
      if (memberIds.length + guestIds.length > config.maxRecipients) break
      if (memberDone && guestDone) break
    }

    const recipientCount = memberIds.length + guestIds.length
    if (recipientCount > config.maxRecipients) {
      await repo.transition(record.id, ["sending"], "failed", { finishedAt: now() })
      await insights.bumpInsightsGeneration(record.cleanupId)
      deps.logger?.error(
        { evt: "broadcast.failed", broadcastId: record.id, recipientCount, reason: "too_many" },
        "broadcast refused: audience above the platform cap",
      )
      return { kind: "too_many", recipients: recipientCount }
    }
    if (recipientCount === 0) {
      await repo.markPlanned(record.id, { recipientCount: 0, plannedAt: now() })
      await repo.transition(record.id, ["sending"], "sent", { finishedAt: now() })
      await insights.bumpInsightsGeneration(record.cleanupId)
      return { kind: "empty", recipients: 0 }
    }

    const chunkSize = Math.max(1, record.chunkSize)

    const rows: DeliveryRowInput[] = []
    const recipients: Array<{ kind: BroadcastRecipientKind; id: string }> = [
      ...memberIds.map((id) => ({ kind: "member" as const, id })),
      ...guestIds.map((id) => ({ kind: "guest" as const, id })),
    ]
    recipients.forEach((recipient, index) => {
      const chunkNo = Math.floor(index / chunkSize)
      for (const channel of record.channels) {
        if (recipient.kind === "guest" && channel !== "email" && channel !== "sms") continue
        rows.push({
          broadcastId: record.id,
          chunkNo,
          recipientKind: recipient.kind,
          userId: recipient.kind === "member" ? recipient.id : null,
          guestId: recipient.kind === "guest" ? recipient.id : null,
          channel,
        })
      }
    })

    for (let i = 0; i < rows.length; i += 500) {
      await repo.insertDeliveries(rows.slice(i, i + 500))
    }

    const reservedNow = await repo.markPlanned(record.id, { recipientCount, plannedAt: now() })
    if (reservedNow && record.createdBy !== null && BUDGETED_KINDS.has(record.kind)) {
      const withinBudget = await deps.service.reserveRecipientBudget(
        record.createdBy,
        recipientCount,
      )
      if (!withinBudget) {
        await repo.suppressRemaining(record.id, "cap")
        await repo.transition(record.id, ["sending"], "failed", { finishedAt: now() })
        await insights.bumpInsightsGeneration(record.cleanupId)
        deps.logger?.warn(
          { evt: "broadcast.failed", broadcastId: record.id, reason: "recipients_per_day" },
          "broadcast refused: host daily recipient budget exhausted",
        )
        return { kind: "over_budget", recipients: recipientCount }
      }
    }

    await insights.bumpInsightsGeneration(record.cleanupId)
    const chunkNos = await repo.listPendingChunks(record.id)
    for (const chunkNo of chunkNos) {
      await deps.enqueueChunk(record.id, chunkNo)
    }
    deps.logger?.info(
      {
        evt: "broadcast.plan.done",
        broadcastId: record.id,
        cleanupId: record.cleanupId,
        recipientCount,
        chunkCount: chunkNos.length,
      },
      "broadcast planned",
    )
    return { kind: "planned", recipients: recipientCount, chunks: chunkNos.length }
  }

  async function runChunk(broadcastId: string, chunkNo: number, authRetry = 0): Promise<void> {
    const record = await repo.findById(broadcastId)
    if (record === null || record.status !== "sending") return
    if (await killed(record)) {
      await killBroadcast(record, "kill_switch_mid_send")
      return
    }
    const event = await repo.eventContext(record.cleanupId)
    if (event === null) return

    const claims = await repo.claimChunk({
      broadcastId,
      chunkNo,
      staleBefore: new Date(now().getTime() - CHUNK_STALE_MS),
      maxAttempts: MAX_DELIVERY_ATTEMPTS,
      limit: Math.max(1, record.chunkSize) * 4,
    })
    if (claims.length === 0) {
      await finalizeIfDrained(record)
      return
    }

    const outcomes: DeliveryOutcome[] = []
    let aborted: ChunkAuthAbort | null = null
    try {
      await runInAppAndPush(record, event, claims, outcomes)
      await runEmail(record, event, claims, outcomes)
    } catch (err) {
      if (!(err instanceof ChunkAuthAbort)) throw err
      aborted = err
    } finally {
      await repo.applyDeliveryOutcomes(outcomes)
      await repo.refreshCounts(broadcastId)
    }
    if (aborted !== null) {
      await repo.releaseClaims(aborted.releasedIds)
      await backOffAfterAuthAbort(broadcastId, chunkNo, authRetry, aborted.cause)
      return
    }
    await finalizeIfDrained(record)
    deps.logger?.info(
      {
        evt: "broadcast.chunk.done",
        broadcastId,
        chunkNo,
        claimed: claims.length,
        applied: outcomes.length,
      },
      "broadcast chunk complete",
    )
  }

  async function backOffAfterAuthAbort(
    broadcastId: string,
    chunkNo: number,
    authRetry: number,
    err: unknown,
  ): Promise<void> {
    const startAfterSec = AUTH_ABORT_BACKOFF_SEC[authRetry]
    if (startAfterSec === undefined) {
      deps.logger?.error(
        { err, evt: "broadcast.chunk.auth_abort", broadcastId, chunkNo, authRetry },
        "broadcast chunk aborted on an SMTP sender rejection and is out of backoff attempts",
      )
      throw err
    }
    deps.logger?.warn(
      { err, evt: "broadcast.chunk.auth_abort", broadcastId, chunkNo, authRetry, startAfterSec },
      "broadcast chunk aborted on an SMTP sender rejection; claims released, retrying after backoff",
    )
    await deps.enqueueChunk(broadcastId, chunkNo, { startAfterSec, authRetry: authRetry + 1 })
  }

  async function finalizeIfDrained(record: BroadcastRecord): Promise<void> {
    const terminalized = await repo.failExhausted(record.id, MAX_DELIVERY_ATTEMPTS)
    if (terminalized > 0) {
      await repo.refreshCounts(record.id)
      deps.logger?.warn(
        { evt: "broadcast.exhausted", broadcastId: record.id, terminalized },
        "broadcast: deliveries out of attempts marked failed",
      )
    }
    const counts = await repo.deliveryCounts(record.id)
    if (counts.pending > 0) return
    const allFailed = counts.sent === 0 && counts.failed > 0
    const finished = await repo.transition(record.id, ["sending"], allFailed ? "failed" : "sent", {
      finishedAt: now(),
    })
    await repo.refreshCounts(record.id)
    if (finished !== null) await insights.bumpInsightsGeneration(record.cleanupId)
  }

  function pushMode(record: BroadcastRecord): PushGateMode {
    if (!record.channels.includes("push")) return "never"
    return CRITICAL_KINDS.has(record.kind) ? "always" : "auto"
  }

  async function runInAppAndPush(
    record: BroadcastRecord,
    event: EventBroadcastContext,
    claims: readonly DeliveryClaim[],
    outcomes: DeliveryOutcome[],
  ): Promise<void> {
    const relevant = claims.filter(
      (c) => (c.channel === "inapp" || c.channel === "push") && c.userId !== null,
    )
    if (relevant.length === 0) return
    const userIds = [...new Set(relevant.map((c) => c.userId as string))]
    const content = `${record.subject ?? ""} ${record.bodyMd ?? ""} ${record.ctaLabel ?? ""}`
    const perRecipient = usesPerRecipientVar(content)
    const [contacts, prefs, ticketTypes] = await Promise.all([
      repo.memberContacts(userIds),
      repo.pushPrefs(userIds),
      usesVar(content, "ticket_type")
        ? repo.ticketTypeNames({ cleanupId: record.cleanupId, userIds, guestIds: [] })
        : Promise.resolve(new Map<string, string>()),
    ])
    const shared = sharedVars(event)
    const oneRendering = perRecipient ? null : render(record, event, shared)
    const type = KIND_NOTIFICATION_TYPE[record.kind]
    const mode = pushMode(record)
    const at = now()

    const deliverable = new Map<string, RenderedBroadcast>()
    for (const claim of relevant) {
      const userId = claim.userId as string
      const contact = contacts.get(userId)
      if (contact === undefined) {
        outcomes.push({ id: claim.id, status: "suppressed", suppressionReason: "deleted_user" })
        continue
      }
      if (claim.channel === "push") {
        const pref = prefs.get(userId)
        const allowed =
          pref === undefined ||
          (pushGateAllows(type, pref, mode) &&
            !isWithinQuietHours(at, pref.quietStart, pref.quietEnd, pref.tz))
        if (mode === "never" || !allowed) {
          outcomes.push({ id: claim.id, status: "suppressed", suppressionReason: "prefs_off" })
          continue
        }
        outcomes.push({ id: claim.id, status: "sent", sentAt: at })
        continue
      }
      const rendering =
        oneRendering ??
        render(record, event, {
          ...shared,
          first_name: contact.firstName,
          ticket_type: ticketTypes.get(userId) ?? "",
        })
      deliverable.set(userId, rendering)
      outcomes.push({ id: claim.id, status: "sent", sentAt: at })
    }

    if (deliverable.size === 0) return
    const groups = new Map<string, { rendering: RenderedBroadcast; userIds: string[] }>()
    for (const [userId, rendering] of deliverable) {
      const key = JSON.stringify([rendering.inAppTitle, rendering.inAppBody])
      const group = groups.get(key)
      if (group !== undefined) group.userIds.push(userId)
      else groups.set(key, { rendering, userIds: [userId] })
    }
    const undelivered = new Set<string>()
    let fanOutError: unknown = null
    for (const group of groups.values()) {
      try {
        await deps.notifications.createNotifications(group.userIds, {
          type,
          title: group.rendering.inAppTitle,
          body: group.rendering.inAppBody,
          link: notificationLink(record, event),
          push: mode,
        })
      } catch (err) {
        fanOutError = err
        for (const userId of group.userIds) undelivered.add(userId)
      }
    }
    if (fanOutError === null) return
    deps.logger?.error(
      { err: fanOutError, broadcastId: record.id, undelivered: undelivered.size },
      "broadcast: in-app fan-out failed for some groups; only those rows return to pending",
    )
    for (const claim of relevant) {
      if (claim.userId === null || !undelivered.has(claim.userId)) continue
      const index = outcomes.findIndex((o) => o.id === claim.id)
      if (index >= 0 && outcomes[index]?.status !== "sent") continue
      if (index >= 0) outcomes.splice(index, 1)
      outcomes.push(
        claim.attempts >= MAX_DELIVERY_ATTEMPTS
          ? { id: claim.id, status: "failed", failureKind: "unknown" }
          : { id: claim.id, status: "pending" },
      )
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
    const content = `${record.subject ?? ""} ${record.bodyMd ?? ""} ${record.ctaLabel ?? ""}`
    const [members, guests, ticketTypes] = await Promise.all([
      repo.memberContacts(memberIds),
      repo.guestContacts(guestIds),
      usesVar(content, "ticket_type")
        ? repo.ticketTypeNames({ cleanupId: record.cleanupId, userIds: memberIds, guestIds })
        : Promise.resolve(new Map<string, string>()),
    ])
    const addresses = new Map<string, string>()
    for (const claim of relevant) {
      const contact =
        claim.userId !== null ? members.get(claim.userId) : guests.get(claim.guestId as string)
      const email = contact?.email
      if (email == null || email.length === 0) continue
      addresses.set(claim.id, emailHashOf(email))
    }
    const suppressedHashes = await repo.suppressedEmailHashes([...addresses.values()])

    const bucket = new TokenBucket(config.emailRatePerSec)
    const critical = CRITICAL_KINDS.has(record.kind)
    const replyTo = event.replyToVerified && event.replyTo ? event.replyTo : null
    const sentAtMs = now().getTime()
    const shared = sharedVars(event)
    let abortError: unknown = null
    const releasedIds: string[] = []

    await mapWithLimit([...relevant], config.emailConcurrency, async (claim): Promise<void> => {
      if (abortError !== null) {
        outcomes.push({ id: claim.id, status: "pending" })
        releasedIds.push(claim.id)
        return
      }
      const isMember = claim.userId !== null
      const contact = isMember
        ? members.get(claim.userId as string)
        : guests.get(claim.guestId as string)
      if (contact === undefined) {
        outcomes.push({
          id: claim.id,
          status: "suppressed",
          suppressionReason: isMember ? "deleted_user" : "contact_scrubbed",
        })
        return
      }
      const email = contact.email
      if (email === null || email.length === 0) {
        outcomes.push({ id: claim.id, status: "suppressed", suppressionReason: "no_contact" })
        return
      }
      const hash = addresses.get(claim.id) ?? emailHashOf(email)
      if (suppressedHashes.has(hash)) {
        outcomes.push({
          id: claim.id,
          status: "suppressed",
          suppressionReason: "bounce_suppressed",
        })
        return
      }
      const fresh = await claimAddress(record.id, hash, claim.id)
      if (!fresh) {
        outcomes.push({ id: claim.id, status: "skipped" })
        return
      }

      const subjectId = (claim.userId ?? claim.guestId) as string
      const firstName = isMember
        ? (members.get(claim.userId as string)?.firstName ?? "")
        : (guests.get(claim.guestId as string)?.name ?? "")
      const token = encodeURIComponent(
        mintUnsubscribeToken(
          {
            subjectKind: isMember ? "user" : "guest",
            subjectId,
            cleanupId: record.cleanupId,
            expiresAtMs: unsubscribeExpiryFrom(sentAtMs),
          },
          config.unsubscribeSigningKey,
        ),
      )
      const unsubscribeUrl = `${config.webBaseUrl}/unsubscribe?t=${token}`
      const oneClickUrl = `${config.apiBaseUrl}/v1/broadcasts/unsubscribe?t=${token}`
      const rendered = renderBroadcast(
        {
          subject: record.subject ?? "",
          bodyMd: record.bodyMd ?? "",
          ctaLabel: record.ctaLabel,
          ctaUrl: record.ctaUrl,
        },
        {
          eventTitle: event.title,
          vars: {
            ...shared,
            first_name: firstName,
            ticket_type: ticketTypes.get(subjectId) ?? "",
          },
          unsubscribeUrl,
          replyTo,
          critical,
          allowedLinkHosts: config.linkAllowedHosts,
        },
      )
      const headers: Record<string, string> = {
        "List-Unsubscribe": `<${oneClickUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      }
      if (AUTOMATED_KINDS.has(record.kind)) headers["Auto-Submitted"] = "auto-generated"

      await bucket.take()
      try {
        const sent = await deps.mailer.sendOutbound({
          from: config.mailFromEvents,
          to: email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          messageId: `<bcast-${claim.id}@${deps.mailDomain}>`,
          headers,
          ...(replyTo !== null ? { replyTo } : {}),
        })
        outcomes.push({
          id: claim.id,
          status: "sent",
          sentAt: now(),
          ...(sent.messageId !== undefined ? { providerMessageId: sent.messageId } : {}),
        })
      } catch (err) {
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
          abortError = err
          await releaseAddress(record.id, hash)
          outcomes.push({ id: claim.id, status: "pending" })
          releasedIds.push(claim.id)
          return
        }
        if (failure.kind === "permanent") {
          await repo.suppressEmail(hash, "hard_bounce").catch(() => undefined)
          outcomes.push({ id: claim.id, status: "failed", failureKind: "permanent" })
          return
        }
        if (failure.kind === "transient" && claim.attempts < MAX_DELIVERY_ATTEMPTS) {
          await releaseAddress(record.id, hash)
          outcomes.push({ id: claim.id, status: "pending" })
          return
        }
        outcomes.push({
          id: claim.id,
          status: "failed",
          failureKind: failure.kind as DeliveryFailureKind,
        })
      }
    })

    if (abortError !== null) throw new ChunkAuthAbort(abortError, releasedIds)
  }

  function addressKey(broadcastId: string, hash: string): string {
    return `bcast:addr:${broadcastId}:${hash}`
  }

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

  function sharedVars(event: EventBroadcastContext): BroadcastVarValues {
    return {
      event_title: event.title,
      event_when: formatEventWhen(event.scheduledAt, event.timezone),
      event_where: event.address ?? "the meeting point",
      manage_link: eventManageUrl(config.webBaseUrl, event.pageSlug, event.cleanupId),
    }
  }

  function render(
    record: BroadcastRecord,
    event: EventBroadcastContext,
    vars: BroadcastVarValues,
  ): RenderedBroadcast {
    return renderBroadcast(
      {
        subject: record.subject ?? "",
        bodyMd: record.bodyMd ?? "",
        ctaLabel: record.ctaLabel,
        ctaUrl: record.ctaUrl,
      },
      {
        eventTitle: event.title,
        vars,
        replyTo: event.replyToVerified ? event.replyTo : null,
        critical: CRITICAL_KINDS.has(record.kind),
        allowedLinkHosts: config.linkAllowedHosts,
      },
    )
  }

  async function releaseScheduled(id: string, at: Date): Promise<boolean> {
    const due = await repo.findById(id)
    if (due === null || due.status !== "scheduled") return false
    if (await organizationSuspendedFor(due)) {
      await failForSuspendedOrganization(due, "scheduled", at)
      return false
    }
    const moved = await repo.transition(id, ["scheduled"], "sending", { startedAt: at })
    if (moved === null) return false
    if (moved.createdBy !== null && moved.kind === "host_broadcast") {
      try {
        await deps.service.reserveSendSlot(moved.cleanupId, moved.createdBy)
      } catch (err) {
        if (!(err instanceof BroadcastCapError)) throw err
        if (err.kind === "kill_switch" || err.kind === "suspended") {
          await plan(id)
          return true
        }
        if (err.kind === "counter_unavailable") {
          await repo.transition(id, ["sending"], "scheduled", { startedAt: null })
          deps.logger?.warn(
            { evt: "broadcast.release.deferred", broadcastId: id },
            "scheduled broadcast returned to scheduled: cap counters unavailable, retrying next sweep",
          )
          return false
        }
        await repo.suppressRemaining(id, "cap")
        await repo.transition(id, ["sending"], "failed", { finishedAt: at })
        await repo.refreshCounts(id)
        await insights.bumpInsightsGeneration(moved.cleanupId)
        deps.logger?.warn(
          { evt: "broadcast.failed", broadcastId: id, reason: err.kind },
          "scheduled broadcast refused at release: send-slot cap",
        )
        return false
      }
    }
    await plan(id)
    return true
  }

  async function sweep(): Promise<{ released: number; resumed: number }> {
    const at = now()
    const due = await repo.listDueScheduled(at, 50)
    let released = 0
    for (const id of due) {
      if (await releaseScheduled(id, at)) released += 1
    }
    const stale = await repo.listStaleSending(new Date(at.getTime() - SENDING_STALE_MS), 20)
    let resumed = 0
    for (const id of stale) {
      const record = await repo.findById(id)
      if (record === null) continue
      if (record.plannedAt === null) {
        await plan(id)
        resumed += 1
        continue
      }
      const counts = await repo.deliveryCounts(id)
      if (counts.pending === 0) {
        await finalizeIfDrained(record)
        continue
      }
      for (const chunkNo of await repo.listPendingChunks(id)) {
        await deps.enqueueChunk(id, chunkNo)
      }
      resumed += 1
    }
    return { released, resumed }
  }

  return { plan, runChunk, sweep, finalizeIfDrained }
}

const DEDUPE_TTL_SEC = 24 * 60 * 60

export type BroadcastPipeline = ReturnType<typeof makeBroadcastPipeline>
