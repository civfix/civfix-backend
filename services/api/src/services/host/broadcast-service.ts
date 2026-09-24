import { AppError } from "@civfix/shared"
import type {
  BroadcastChannel,
  BroadcastDTO,
  BroadcastDeliveryDTO,
  BroadcastPreviewDTO,
  BroadcastSegment,
  BroadcastStatus,
  CreateEventBroadcastRequest,
  ListBroadcastDeliveriesRequest,
  ListEventBroadcastsRequest,
  PreviewEventBroadcastRequest,
  UpdateEventBroadcastRequest,
} from "@civfix/shared"
import type { BroadcastVarValues } from "@civfix/shared/host"
import type { Mailer } from "@civfix/shared/interfaces"
import type { FastifyBaseLogger } from "fastify"
import { assertNoSlur } from "../../abuse/slur-filter.js"
import type { CounterStore } from "../../abuse/counter-store.js"
import { paginateKeyset, parseKeysetCursor } from "../../db/cursor-helpers.js"
import { sha256HexSync } from "../../lib/hash.js"
import { MS_PER_HOUR, SECONDS_PER_DAY } from "../../lib/time.js"
import type { BroadcastRepository } from "./broadcast-repository.js"
import type {
  BroadcastDraftPatch,
  BroadcastRecord,
  EventBroadcastContext,
} from "./broadcast-types.js"
import { CRITICAL_BROADCAST_KINDS } from "./broadcast-types.js"
import {
  assertBroadcastLinkPolicy,
  broadcastContentOf,
  broadcastLinkWarnings,
  eventTemplateVars,
  renderBroadcast,
  verifiedReplyTo,
} from "./broadcast-render.js"
import { verifyUnsubscribeToken } from "./broadcast-capability-token.js"

const BROADCAST_DEFAULT_LIMIT = 20
const BROADCAST_TEST_SENDS_PER_HOUR = 5
const TEST_SEND_WINDOW_SEC = 60 * 60
const ISO_DAY_LENGTH = 10
const COOLDOWN_SENDS = 1
const PREVIEW_SAMPLE_FIRST_NAME = "Alex"
const PREVIEW_SAMPLE_TICKET_TYPE = "General"
const TEST_SUBJECT_PREFIX = "[Test] "

export interface BroadcastConfig {
  killSwitch: boolean
  perEventPerDay: number
  recipientsPerDay: number
  cooldownSec: number
  minAccountAgeHours: number
  maxRecipients: number
  chunkSize: number
  emailConcurrency: number
  emailRatePerSec: number
  linkAllowedHosts: string[]
  mailFromEvents: string
  unsubscribeSigningKey: string
  webBaseUrl: string
  apiBaseUrl: string
  eventUpdatePerEventPerHour: number
}

export interface BroadcastServiceDeps {
  repo: BroadcastRepository
  counters: CounterStore
  config: BroadcastConfig
  mailer: Mailer
  enqueuePlan: (broadcastId: string) => Promise<void>
  logger?: Pick<FastifyBaseLogger, "info" | "warn" | "error">
  now?: () => Date
}

export type CapKind =
  | "kill_switch"
  | "suspended"
  | "unverified_email"
  | "account_too_new"
  | "cooldown"
  | "per_event_per_day"
  | "recipients_per_day"
  | "test_sends"
  | "counter_unavailable"

export class BroadcastCapError extends Error {
  readonly kind: CapKind

  constructor(kind: CapKind, message: string) {
    super(message)
    this.name = "BroadcastCapError"
    this.kind = kind
  }
}

const CAP_COPY: Record<CapKind, string> = {
  kill_switch: "Messaging attendees is temporarily paused. Try again later.",
  suspended: "Messaging attendees is disabled on this account. Contact support.",
  unverified_email: "Verify your email address before messaging attendees.",
  account_too_new: "New accounts can message attendees 24 hours after signing up.",
  cooldown: "You just sent a message for this event. Give it a few minutes.",
  per_event_per_day: "This event has reached its daily message limit.",
  recipients_per_day: "You have reached today's limit for how many people you can message.",
  test_sends: "You have sent several test messages. Try again in an hour.",
  counter_unavailable: "Messaging is temporarily unavailable. Try again in a moment.",
}

export function capError(kind: CapKind): AppError {
  if (kind === "unverified_email" || kind === "account_too_new") {
    return AppError.forbidden(CAP_COPY[kind])
  }
  if (kind === "kill_switch" || kind === "suspended" || kind === "counter_unavailable") {
    return AppError.conflict(CAP_COPY[kind])
  }
  return AppError.rateLimited(CAP_COPY[kind])
}

export function emailHashOf(email: string): string {
  return sha256HexSync(email.trim().toLowerCase())
}

function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, ISO_DAY_LENGTH)
}

export async function withCaps<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof BroadcastCapError) throw capError(err.kind)
    throw err
  }
}

function toBroadcastDTO(record: BroadcastRecord): BroadcastDTO {
  return {
    id: record.id,
    cleanupId: record.cleanupId,
    kind: record.kind,
    status: record.status,
    subject: record.subject,
    bodyMd: record.bodyMd,
    ctaLabel: record.ctaLabel,
    ctaUrl: record.ctaUrl,
    segment: record.segment,
    channels: record.channels,
    replyTo: record.replyTo,
    reminderOffsetMin: record.reminderOffsetMin,
    scheduledAt: record.scheduledAt?.toISOString() ?? null,
    startedAt: record.startedAt?.toISOString() ?? null,
    finishedAt: record.finishedAt?.toISOString() ?? null,
    recipientCount: record.recipientCount,
    sentCount: record.sentCount,
    failedCount: record.failedCount,
    suppressedCount: record.suppressedCount,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt?.toISOString() ?? null,
    contentScrubbedAt: record.contentScrubbedAt?.toISOString() ?? null,
  }
}

export interface BroadcastService {
  list(
    cleanupId: string,
    query: ListEventBroadcastsRequest,
  ): Promise<{
    items: BroadcastDTO[]
    nextCursor: string | null
  }>
  get(cleanupId: string, broadcastId: string): Promise<BroadcastDTO>
  create(
    cleanupId: string,
    actorId: string,
    body: CreateEventBroadcastRequest,
  ): Promise<BroadcastDTO>
  update(
    cleanupId: string,
    actorId: string,
    body: UpdateEventBroadcastRequest,
  ): Promise<BroadcastDTO>
  remove(cleanupId: string, broadcastId: string): Promise<{ ok: true }>
  preview(
    cleanupId: string,
    actorId: string,
    body: PreviewEventBroadcastRequest,
  ): Promise<BroadcastPreviewDTO>
  testSend(cleanupId: string, actorId: string, broadcastId: string): Promise<{ ok: true }>
  send(cleanupId: string, actorId: string, broadcastId: string): Promise<BroadcastDTO>
  sendAnnouncement(cleanupId: string, actorId: string, broadcastId: string): Promise<BroadcastDTO>
  schedule(
    cleanupId: string,
    actorId: string,
    broadcastId: string,
    scheduledAt: Date,
  ): Promise<BroadcastDTO>
  cancel(cleanupId: string, broadcastId: string): Promise<BroadcastDTO>
  listDeliveries(
    cleanupId: string,
    query: ListBroadcastDeliveriesRequest,
  ): Promise<{ items: BroadcastDeliveryDTO[]; nextCursor: string | null }>
  setMute(cleanupId: string, userId: string, muted: boolean): Promise<{ muted: boolean }>
  unsubscribe(token: string): Promise<{ ok: true }>
  assertComposeAllowed(cleanupId: string, actorId: string): Promise<void>
  reserveSendSlot(cleanupId: string, actorId: string): Promise<void>
  reserveRecipientBudget(actorId: string, recipients: number): Promise<boolean>
}

export function makeBroadcastService(deps: BroadcastServiceDeps): BroadcastService {
  const now = deps.now ?? (() => new Date())
  const { repo, config } = deps

  function notFound(): AppError {
    return AppError.notFound("Message not found")
  }

  async function guardHost(actorId: string): Promise<void> {
    if (config.killSwitch) throw new BroadcastCapError("kill_switch", CAP_COPY.kill_switch)
    let state: Awaited<ReturnType<BroadcastRepository["hostMessagingState"]>>
    try {
      state = await repo.hostMessagingState(actorId)
    } catch (err) {
      deps.logger?.warn(
        { err, actorId },
        "broadcast: host messaging state unavailable; refusing (fail closed)",
      )
      throw new BroadcastCapError("counter_unavailable", CAP_COPY.counter_unavailable)
    }
    if (state === null) throw new BroadcastCapError("suspended", CAP_COPY.suspended)
    if (state.suspended) throw new BroadcastCapError("suspended", CAP_COPY.suspended)
    if (!state.emailVerified) {
      throw new BroadcastCapError("unverified_email", CAP_COPY.unverified_email)
    }
    const ageHours = (now().getTime() - state.accountCreatedAt.getTime()) / MS_PER_HOUR
    if (ageHours < config.minAccountAgeHours) {
      throw new BroadcastCapError("account_too_new", CAP_COPY.account_too_new)
    }
  }

  async function reserve(
    key: string,
    ttlSeconds: number,
    limit: number,
    kind: CapKind,
  ): Promise<void> {
    let used: number
    try {
      used = await deps.counters.incr(key, ttlSeconds)
    } catch (err) {
      deps.logger?.warn({ err, kind }, "broadcast: cap counter unavailable; refusing (fail closed)")
      throw new BroadcastCapError("counter_unavailable", CAP_COPY.counter_unavailable)
    }
    if (used > limit) {
      await giveBack(key, kind)
      throw new BroadcastCapError(kind, CAP_COPY[kind])
    }
  }

  async function giveBack(key: string, kind: CapKind): Promise<void> {
    try {
      await deps.counters.decrBy(key, 1)
    } catch (err) {
      deps.logger?.warn(
        { err, kind },
        "broadcast: a refused send could not give its charge back; it stays spent until the window ends",
      )
    }
  }

  function linkPolicyText(bodyMd: string, ctaUrl: string | null | undefined): string {
    return ctaUrl != null && ctaUrl.length > 0 ? `${bodyMd}\n${ctaUrl}` : bodyMd
  }

  function assertContent(subject: string, bodyMd: string, ctaUrl: string | null | undefined): void {
    assertNoSlur(subject, "subject")
    assertNoSlur(bodyMd, "bodyMd")
    assertBroadcastLinkPolicy(linkPolicyText(bodyMd, ctaUrl), config.linkAllowedHosts)
  }

  async function reserveSendCounters(cleanupId: string, actorId: string): Promise<void> {
    const cooldownKey = `bcast:cool:${actorId}:${cleanupId}`
    await reserve(cooldownKey, config.cooldownSec, COOLDOWN_SENDS, "cooldown")
    try {
      await reserve(
        `bcast:event:${cleanupId}:${utcDayKey(now())}`,
        SECONDS_PER_DAY,
        config.perEventPerDay,
        "per_event_per_day",
      )
    } catch (err) {
      await giveBack(cooldownKey, "cooldown")
      throw err
    }
  }

  async function reserveSendSlot(cleanupId: string, actorId: string): Promise<void> {
    await guardHost(actorId)
    await reserveSendCounters(cleanupId, actorId)
  }

  async function requireDraft(cleanupId: string, broadcastId: string): Promise<BroadcastRecord> {
    const record = await repo.findForEvent(cleanupId, broadcastId)
    if (record === null) throw notFound()
    return record
  }

  /**
   * A critical automated notice (the event was cancelled or changed) is the platform telling attendees,
   * not a host message: anyone holding `broadcast`, a coordinator included, must not be able to stop,
   * rewrite or delete it.
   */
  async function requireHostControllable(
    cleanupId: string,
    broadcastId: string,
    refusal: string,
  ): Promise<BroadcastRecord> {
    const record = await requireDraft(cleanupId, broadcastId)
    if (CRITICAL_BROADCAST_KINDS.has(record.kind)) throw AppError.conflict(refusal)
    return record
  }

  /**
   * The org-suspension gate (DECISIONS §32): an event linked to an operator-suspended organization
   * cannot compose, send or schedule host broadcasts. Same code + wording as the org service's own
   * self-service gate; the per-host messaging suspension in guardHost is a different lever.
   */
  async function requireEventOrgNotSuspended(cleanupId: string): Promise<EventBroadcastContext> {
    const event = await repo.eventContext(cleanupId)
    if (event === null) throw notFound()
    if (event.organizationSuspended) {
      throw AppError.forbidden(
        "This organization has been suspended, so it can't message attendees right now.",
      )
    }
    return event
  }

  async function sendBroadcast(
    cleanupId: string,
    actorId: string,
    broadcastId: string,
    skipEventSendCounters: boolean,
  ): Promise<BroadcastDTO> {
    await guardHost(actorId)
    const record = await requireDraft(cleanupId, broadcastId)
    if (record.subject === null || record.bodyMd === null) {
      throw AppError.conflict("That message has no content to send.")
    }
    assertContent(record.subject, record.bodyMd, record.ctaUrl)
    const event = await requireEventOrgNotSuspended(cleanupId)
    const moved = await repo.transition(broadcastId, ["draft", "scheduled"], "sending", {
      startedAt: now(),
      replyTo: verifiedReplyTo(event),
    })
    if (moved === null) throw AppError.conflict("That message is already sending.")
    if (!skipEventSendCounters) {
      try {
        await reserveSendCounters(cleanupId, actorId)
      } catch (err) {
        await repo.transition(broadcastId, ["sending"], record.status, { startedAt: null })
        throw err
      }
    }
    try {
      await deps.enqueuePlan(broadcastId)
    } catch (err) {
      await releaseUnplannedSend(broadcastId, record.status)
      throw err
    }
    return toBroadcastDTO(moved)
  }

  /**
   * The host is told the send failed, so the row must not stay 'sending': the stale-sending sweep would
   * deliver it minutes later anyway. Rolling back is safe even when the enqueue did land, because plan()
   * skips any broadcast that is no longer 'sending'.
   */
  async function releaseUnplannedSend(
    broadcastId: string,
    previous: BroadcastStatus,
  ): Promise<void> {
    try {
      await repo.transition(broadcastId, ["sending"], previous, { startedAt: null })
    } catch (err) {
      deps.logger?.error(
        { err, broadcastId },
        "broadcast: could not roll back a send whose plan job failed to enqueue; the sweep will send it",
      )
    }
  }

  return {
    async list(cleanupId, query) {
      const limit = query.limit ?? BROADCAST_DEFAULT_LIMIT
      const rows = await repo.list({
        cleanupId,
        ...(query.status !== undefined ? { status: query.status } : {}),
        cursor: parseKeysetCursor(query.cursor, { direction: "desc" }),
        limit: limit + 1,
      })
      const { items, nextCursor } = paginateKeyset(rows, limit, (row) => ({
        atText: row.cursorAt,
        id: row.id,
      }))
      return { items: items.map(toBroadcastDTO), nextCursor }
    },

    async get(cleanupId, broadcastId) {
      return toBroadcastDTO(await requireDraft(cleanupId, broadcastId))
    },

    async create(cleanupId, actorId, body) {
      await guardHost(actorId)
      await requireEventOrgNotSuspended(cleanupId)
      assertContent(body.subject, body.bodyMd, body.ctaUrl)
      const record = await repo.create({
        cleanupId,
        createdBy: actorId,
        kind: "host_broadcast",
        subject: body.subject,
        bodyMd: body.bodyMd,
        ctaLabel: body.ctaLabel ?? null,
        ctaUrl: body.ctaUrl ?? null,
        segment: body.segment,
        channels: body.channels,
        status: "draft",
        chunkSize: config.chunkSize,
      })
      return toBroadcastDTO(record)
    },

    async update(cleanupId, actorId, body) {
      await guardHost(actorId)
      const current = await requireHostControllable(
        cleanupId,
        body.broadcastId,
        "Automatic messages can't be edited.",
      )
      const subject = body.subject ?? current.subject ?? ""
      const bodyMd = body.bodyMd ?? current.bodyMd ?? ""
      const ctaUrl = "ctaUrl" in body ? (body.ctaUrl ?? null) : current.ctaUrl
      assertContent(subject, bodyMd, ctaUrl)
      const patch: BroadcastDraftPatch = {
        ...(body.subject !== undefined ? { subject: body.subject } : {}),
        ...(body.bodyMd !== undefined ? { bodyMd: body.bodyMd } : {}),
        ...("ctaLabel" in body ? { ctaLabel: body.ctaLabel ?? null } : {}),
        ...("ctaUrl" in body ? { ctaUrl: body.ctaUrl ?? null } : {}),
        ...(body.segment !== undefined ? { segment: body.segment } : {}),
        ...(body.channels !== undefined ? { channels: body.channels } : {}),
      }
      let updated: BroadcastRecord | null = current.status === "draft" ? current : null
      if (Object.keys(patch).length > 0) {
        updated = await repo.updateDraft(cleanupId, body.broadcastId, patch)
      }
      if (updated === null) {
        throw AppError.conflict("That message has already been sent or scheduled.")
      }
      return toBroadcastDTO(updated)
    },

    async remove(cleanupId, broadcastId) {
      await requireHostControllable(cleanupId, broadcastId, "Automatic messages can't be deleted.")
      const deleted = await repo.deleteDraft(cleanupId, broadcastId)
      if (!deleted) throw AppError.conflict("That message can no longer be deleted.")
      return { ok: true }
    },

    async preview(cleanupId, actorId, body) {
      await guardHost(actorId)
      const event = await repo.eventContext(cleanupId)
      if (event === null) throw notFound()
      const existing =
        body.broadcastId !== undefined ? await repo.findForEvent(cleanupId, body.broadcastId) : null
      const subject = body.subject ?? existing?.subject ?? ""
      const bodyMd = body.bodyMd ?? existing?.bodyMd ?? ""
      if (subject.length === 0 || bodyMd.length === 0) {
        throw AppError.validation({ bodyMd: "required" }, "Nothing to preview yet.")
      }
      assertNoSlur(subject, "subject")
      assertNoSlur(bodyMd, "bodyMd")
      const segment: BroadcastSegment = body.segment ??
        existing?.segment ?? { kind: "all_registered" }
      const rendered = renderBroadcast(
        {
          subject,
          bodyMd,
          ctaLabel: body.ctaLabel ?? existing?.ctaLabel ?? null,
          ctaUrl: body.ctaUrl ?? existing?.ctaUrl ?? null,
        },
        {
          eventTitle: event.title,
          vars: previewVars(event, config.webBaseUrl),
          unsubscribeUrl: `${config.webBaseUrl}/unsubscribe`,
          replyTo: verifiedReplyTo(event),
          allowedLinkHosts: config.linkAllowedHosts,
        },
      )
      const recipientCount = await countAudience(repo, cleanupId, segment, config.maxRecipients)
      return {
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        pushTitle: rendered.pushTitle,
        pushBody: rendered.pushBody,
        inAppTitle: rendered.inAppTitle,
        inAppBody: rendered.inAppBody,
        recipientCount,
        warnings: broadcastLinkWarnings(
          linkPolicyText(bodyMd, body.ctaUrl ?? existing?.ctaUrl ?? null),
          config.linkAllowedHosts,
        ),
      }
    },

    async testSend(cleanupId, actorId, broadcastId) {
      await guardHost(actorId)
      await reserve(
        `bcast:test:${actorId}`,
        TEST_SEND_WINDOW_SEC,
        BROADCAST_TEST_SENDS_PER_HOUR,
        "test_sends",
      )
      const record = await requireDraft(cleanupId, broadcastId)
      const event = await repo.eventContext(cleanupId)
      if (event === null) throw notFound()
      const contacts = await repo.memberContacts([actorId])
      const contact = contacts.get(actorId)
      if (contact?.email == null) {
        throw AppError.validation({ email: "missing" }, "Add an email address to send a test.")
      }
      const rendered = renderBroadcast(broadcastContentOf(record), {
        eventTitle: event.title,
        vars: {
          ...previewVars(event, config.webBaseUrl),
          first_name: contact.firstName,
        },
        unsubscribeUrl: `${config.webBaseUrl}/unsubscribe`,
        replyTo: verifiedReplyTo(event),
        allowedLinkHosts: config.linkAllowedHosts,
      })
      await deps.mailer.sendOutbound({
        from: config.mailFromEvents,
        to: contact.email,
        subject: `${TEST_SUBJECT_PREFIX}${rendered.subject}`,
        text: rendered.text,
        html: rendered.html,
        headers: { "Auto-Submitted": "auto-generated" },
      })
      return { ok: true }
    },

    async send(cleanupId, actorId, broadcastId) {
      return sendBroadcast(cleanupId, actorId, broadcastId, false)
    },

    async sendAnnouncement(cleanupId, actorId, broadcastId) {
      return sendBroadcast(cleanupId, actorId, broadcastId, true)
    },

    async schedule(cleanupId, actorId, broadcastId, scheduledAt) {
      await guardHost(actorId)
      const record = await requireDraft(cleanupId, broadcastId)
      if (record.subject === null || record.bodyMd === null) {
        throw AppError.conflict("That message has no content to send.")
      }
      if (scheduledAt.getTime() <= now().getTime()) {
        throw AppError.validation({ scheduledAt: "must be in the future" })
      }
      await requireEventOrgNotSuspended(cleanupId)
      const moved = await repo.transition(broadcastId, ["draft", "scheduled"], "scheduled", {
        scheduledAt,
      })
      if (moved === null) throw AppError.conflict("That message is already sending.")
      return toBroadcastDTO(moved)
    },

    async cancel(cleanupId, broadcastId) {
      await requireHostControllable(
        cleanupId,
        broadcastId,
        "Automatic messages can't be cancelled.",
      )
      const moved = await repo.transition(
        broadcastId,
        ["draft", "scheduled", "sending"],
        "cancelled",
        { finishedAt: now() },
      )
      if (moved === null) throw AppError.conflict("That message has already finished.")
      await repo.suppressRemaining(broadcastId, "cancelled")
      await repo.refreshCounts(broadcastId)
      return toBroadcastDTO(moved)
    },

    async listDeliveries(cleanupId, query) {
      const record = await repo.findForEvent(cleanupId, query.broadcastId)
      if (record === null) throw notFound()
      const limit = query.limit ?? BROADCAST_DEFAULT_LIMIT
      const rows = await repo.listDeliveries({
        broadcastId: query.broadcastId,
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.channel !== undefined ? { channel: query.channel } : {}),
        cursor: parseKeysetCursor(query.cursor, { direction: "desc" }),
        limit: limit + 1,
      })
      const { items, nextCursor } = paginateKeyset(rows, limit, (row) => ({
        atText: row.cursorAt,
        id: row.id,
      }))
      return {
        items: items.map((row) => ({
          id: row.id,
          channel: row.channel as BroadcastChannel,
          recipientKind: row.recipientKind,
          recipientLabel: row.recipientKind === "member" ? "Member" : "Guest",
          status: row.status,
          suppressionReason: row.suppressionReason as BroadcastDeliveryDTO["suppressionReason"],
          failureKind: row.failureKind as BroadcastDeliveryDTO["failureKind"],
          attempts: row.attempts,
          sentAt: row.sentAt?.toISOString() ?? null,
        })),
        nextCursor,
      }
    },

    async setMute(cleanupId, userId, muted) {
      await repo.setEventMute(cleanupId, userId, muted)
      return { muted }
    },

    async unsubscribe(token) {
      const capability = verifyUnsubscribeToken(
        token,
        config.unsubscribeSigningKey,
        now().getTime(),
      )
      if (capability !== null) {
        await repo.recordUnsubscribe({
          scope: "event",
          cleanupId: capability.cleanupId,
          subjectKind: capability.subjectKind,
          subjectId: capability.subjectId,
          reason: "one_click",
        })
      }
      return { ok: true }
    },

    async assertComposeAllowed(_cleanupId, actorId) {
      await guardHost(actorId)
    },

    reserveSendSlot,

    async reserveRecipientBudget(actorId, recipients) {
      if (recipients <= 0) return true
      const chargedKey = `bcast:host:${actorId}:${utcDayKey(now())}`
      let used: number
      try {
        used = await deps.counters.incrBy(chargedKey, recipients, SECONDS_PER_DAY)
      } catch (err) {
        deps.logger?.warn(
          { err, actorId },
          "broadcast: recipient budget counter unavailable; refusing (fail closed)",
        )
        return false
      }
      if (used <= config.recipientsPerDay) return true
      try {
        await deps.counters.decrBy(chargedKey, recipients)
      } catch (err) {
        deps.logger?.warn(
          { err, actorId, recipients },
          "broadcast: refused recipients could not be given back; they stay charged until the UTC day rolls",
        )
      }
      return false
    },
  }
}

function previewVars(event: EventBroadcastContext, webBaseUrl: string): BroadcastVarValues {
  return {
    ...eventTemplateVars(event, webBaseUrl),
    first_name: PREVIEW_SAMPLE_FIRST_NAME,
    ticket_type: PREVIEW_SAMPLE_TICKET_TYPE,
  }
}

async function countAudience(
  repo: BroadcastRepository,
  cleanupId: string,
  segment: BroadcastSegment,
  cap: number,
): Promise<number> {
  if (cap <= 0) return cap
  const total = await repo.audienceCount({ cleanupId, segment, kind: "host_broadcast", cap })
  return Math.min(total, cap)
}
