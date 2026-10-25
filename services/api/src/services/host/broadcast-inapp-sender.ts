import type { BroadcastKind, NotificationType } from "@civfix/contract"
import type { BroadcastVarValues } from "@civfix/contract/host"
import type { FastifyBaseLogger } from "fastify"
import { isWithinQuietHours } from "../notification-helpers.js"
import type { NotificationService } from "../notification-service.js"
import { categorySettingsOfMany } from "../notification-categories.js"
import type { NotificationSettingsRepository } from "../notification-settings-repository.js"
import type { BroadcastRepository } from "./broadcast-repository.js"
import type {
  BroadcastRecord,
  DeliveryClaim,
  DeliveryOutcome,
  EventBroadcastContext,
  MemberContact,
} from "./broadcast-types.js"
import {
  BROADCAST_KIND_CATEGORY,
  CRITICAL_BROADCAST_KINDS,
  MAX_DELIVERY_ATTEMPTS,
} from "./broadcast-types.js"
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
  settingsRepo: Pick<NotificationSettingsRepository, "getSettingsMany">
  logger?: Pick<FastifyBaseLogger, "error">
  now: () => Date
}

interface RenderGroup {
  rendering: RenderedBroadcast
  userIds: string[]
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
    deliverable: ReadonlyMap<string, RenderedBroadcast>,
  ): Promise<{ undelivered: Set<string>; fanOutError: unknown }> {
    const category = BROADCAST_KIND_CATEGORY[record.kind]
    const undelivered = new Set<string>()
    let fanOutError: unknown = null
    for (const group of groupByRendering(deliverable)) {
      try {
        const { failed } = await deps.notifications.createNotificationsReportingFailures(
          group.userIds,
          {
            type: KIND_NOTIFICATION_TYPE[record.kind],
            ...(category !== null ? { category } : {}),
            title: group.rendering.inAppTitle,
            body: group.rendering.inAppBody,
            link: notificationLink(record, event),
            push: record.channels.includes("push") ? "auto" : "never",
            // The broadcast lane mails its own email, so no generic one goes out (D1).
            email: "never",
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
    const [contacts, quietHours, settingOf, ticketTypes] = await Promise.all([
      repo.memberContacts(userIds),
      repo.quietHours(userIds),
      categorySettingsOfMany(deps.settingsRepo, userIds, BROADCAST_KIND_CATEGORY[record.kind]),
      usesVar(content, "ticket_type")
        ? repo.ticketTypeNames({ cleanupId: record.cleanupId, userIds, guestIds: [] })
        : Promise.resolve(new Map<string, string>()),
    ])
    const shared = eventTemplateVars(event, config.webBaseUrl)
    const oneRendering = perRecipient ? null : render(record, event, shared)
    const at = deps.now()
    const inQuietHours = (userId: string): boolean => {
      const quiet = quietHours.get(userId)
      return (
        quiet !== undefined && isWithinQuietHours(at, quiet.quietStart, quiet.quietEnd, quiet.tz)
      )
    }

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
      // D2: the host's channels meet the recipient's category. Off skips both channels, and a skipped
      // channel is prefs_off, never a failure, so nothing retries it.
      const setting = settingOf(userId)
      const allowed =
        setting === null || (setting.enabled && (claim.channel === "inapp" || setting.push))
      if (!allowed || (claim.channel === "push" && inQuietHours(userId))) {
        outcomes.push({ id: claim.id, status: "suppressed", suppressionReason: "prefs_off" })
        continue
      }
      if (claim.channel === "push") {
        outcomes.push({ id: claim.id, status: "sent", sentAt: at })
        continue
      }
      deliverable.set(userId, renderingFor(userId, contact))
      outcomes.push({ id: claim.id, status: "sent", sentAt: at })
    }

    if (deliverable.size === 0) return
    const { undelivered, fanOutError } = await fanOut(record, event, deliverable)
    if (undelivered.size === 0) return
    deps.logger?.error(
      { err: fanOutError, broadcastId: record.id, undelivered: undelivered.size },
      "broadcast: in-app fan-out failed for some recipients; only those rows return to pending",
    )
    requeueUndelivered(relevant, undelivered, outcomes)
  }

  return { runInAppAndPush }
}
