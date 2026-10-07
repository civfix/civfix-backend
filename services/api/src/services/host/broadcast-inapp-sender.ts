import type { BroadcastKind, NotificationType } from "@civfix/shared"
import type { BroadcastVarValues } from "@civfix/shared/host"
import type { FastifyBaseLogger } from "fastify"
import { isWithinQuietHours, pushGateAllows, type PushGateMode } from "../notification-helpers.js"
import type { NotificationService } from "../notification-service.js"
import type { NotificationPrefsRecord } from "../notification-repository.js"
import type { BroadcastRepository } from "./broadcast-repository.js"
import type {
  BroadcastRecord,
  DeliveryClaim,
  DeliveryOutcome,
  EventBroadcastContext,
  MemberContact,
} from "./broadcast-types.js"
import { CRITICAL_BROADCAST_KINDS, MAX_DELIVERY_ATTEMPTS } from "./broadcast-types.js"
import {
  broadcastContentOf,
  eventTemplateVars,
  notificationLink,
  renderBroadcast,
  templateTextOf,
  usesPerRecipientVar,
  usesVar,
  verifiedReplyTo,
  type RenderedBroadcast,
} from "./broadcast-render.js"
import type { BroadcastConfig } from "./broadcast-service.js"

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

export interface BroadcastInAppSenderDeps {
  repo: BroadcastRepository
  config: Pick<BroadcastConfig, "linkAllowedHosts" | "webBaseUrl">
  notifications: NotificationService
  logger?: Pick<FastifyBaseLogger, "error">
  now: () => Date
}

interface RenderGroup {
  rendering: RenderedBroadcast
  userIds: string[]
}

function pushMode(record: BroadcastRecord): PushGateMode {
  if (!record.channels.includes("push")) return "never"
  return CRITICAL_BROADCAST_KINDS.has(record.kind) ? "always" : "auto"
}

function pushAllowed(
  pref: NotificationPrefsRecord | undefined,
  type: NotificationType,
  mode: PushGateMode,
  at: Date,
): boolean {
  if (mode === "never") return false
  return (
    pref === undefined ||
    (pushGateAllows(type, pref, mode) &&
      !isWithinQuietHours(at, pref.quietStart, pref.quietEnd, pref.tz))
  )
}

/** One notification call per distinct rendering, so a shared message fans out in a single batch. */
function groupByRendering(deliverable: ReadonlyMap<string, RenderedBroadcast>): RenderGroup[] {
  const groups = new Map<string, RenderGroup>()
  for (const [userId, rendering] of deliverable) {
    const key = JSON.stringify([rendering.inAppTitle, rendering.inAppBody])
    const group = groups.get(key)
    if (group !== undefined) group.userIds.push(userId)
    else groups.set(key, { rendering, userIds: [userId] })
  }
  return [...groups.values()]
}

function requeueUndelivered(
  claims: readonly DeliveryClaim[],
  undelivered: ReadonlySet<string>,
  outcomes: DeliveryOutcome[],
): void {
  for (const claim of claims) {
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

export function makeBroadcastInAppSender(deps: BroadcastInAppSenderDeps) {
  const { repo, config } = deps

  function render(
    record: BroadcastRecord,
    event: EventBroadcastContext,
    vars: BroadcastVarValues,
  ): RenderedBroadcast {
    return renderBroadcast(broadcastContentOf(record), {
      eventTitle: event.title,
      vars,
      replyTo: verifiedReplyTo(event),
      critical: CRITICAL_BROADCAST_KINDS.has(record.kind),
      allowedLinkHosts: config.linkAllowedHosts,
    })
  }

  async function fanOut(
    record: BroadcastRecord,
    event: EventBroadcastContext,
    type: NotificationType,
    mode: PushGateMode,
    deliverable: ReadonlyMap<string, RenderedBroadcast>,
  ): Promise<{ undelivered: Set<string>; fanOutError: unknown }> {
    const undelivered = new Set<string>()
    let fanOutError: unknown = null
    for (const group of groupByRendering(deliverable)) {
      try {
        const { failed } = await deps.notifications.createNotificationsReportingFailures(
          group.userIds,
          {
            type,
            title: group.rendering.inAppTitle,
            body: group.rendering.inAppBody,
            link: notificationLink(record, event),
            push: mode,
          },
        )
        for (const userId of failed) undelivered.add(userId)
      } catch (err) {
        fanOutError = err
        for (const userId of group.userIds) undelivered.add(userId)
      }
    }
    return { undelivered, fanOutError }
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
    const content = templateTextOf(record)
    const perRecipient = usesPerRecipientVar(content)
    const [contacts, prefs, ticketTypes] = await Promise.all([
      repo.memberContacts(userIds),
      repo.pushPrefs(userIds),
      usesVar(content, "ticket_type")
        ? repo.ticketTypeNames({ cleanupId: record.cleanupId, userIds, guestIds: [] })
        : Promise.resolve(new Map<string, string>()),
    ])
    const shared = eventTemplateVars(event, config.webBaseUrl)
    const oneRendering = perRecipient ? null : render(record, event, shared)
    const type = KIND_NOTIFICATION_TYPE[record.kind]
    const mode = pushMode(record)
    const at = deps.now()

    const renderingFor = (userId: string, contact: MemberContact): RenderedBroadcast =>
      oneRendering ??
      render(record, event, {
        ...shared,
        first_name: contact.firstName,
        ticket_type: ticketTypes.get(userId) ?? "",
      })

    const deliverable = new Map<string, RenderedBroadcast>()
    for (const claim of relevant) {
      const userId = claim.userId as string
      const contact = contacts.get(userId)
      if (contact === undefined) {
        outcomes.push({ id: claim.id, status: "suppressed", suppressionReason: "deleted_user" })
        continue
      }
      if (claim.channel === "push") {
        outcomes.push(
          pushAllowed(prefs.get(userId), type, mode, at)
            ? { id: claim.id, status: "sent", sentAt: at }
            : { id: claim.id, status: "suppressed", suppressionReason: "prefs_off" },
        )
        continue
      }
      deliverable.set(userId, renderingFor(userId, contact))
      outcomes.push({ id: claim.id, status: "sent", sentAt: at })
    }

    if (deliverable.size === 0) return
    const { undelivered, fanOutError } = await fanOut(record, event, type, mode, deliverable)
    if (undelivered.size === 0) return
    deps.logger?.error(
      { err: fanOutError, broadcastId: record.id, undelivered: undelivered.size },
      "broadcast: in-app fan-out failed for some recipients; only those rows return to pending",
    )
    requeueUndelivered(relevant, undelivered, outcomes)
  }

  return { runInAppAndPush }
}
