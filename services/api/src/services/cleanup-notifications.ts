import type { Jobs } from "@civfix/shared/interfaces"
import type { MessageKey } from "../i18n/messages/en.js"
import type { NotificationService } from "./notification-service.js"
import { mapWithLimit } from "../lib/concurrency.js"
import { MS_PER_HOUR } from "../lib/time.js"
import type { CleanupRepository, SlotReconcileResult } from "./cleanup-repository.types.js"
import { CLEANUP_GUEST_UPDATE_FANOUT_JOB, type GuestUpdateFanoutJob } from "./guest-rsvp-service.js"

export const CANCEL_FANOUT_MEMBER_CAP = 2000

const CANCEL_FANOUT_CONCURRENCY = 8

export const CLEANUP_CANCEL_FANOUT_JOB = "cleanup.cancel.fanout"

const CANCEL_FANOUT_DEDUPE_WINDOW_MS = MS_PER_HOUR

export interface CleanupCancelFanoutJob {
  cleanupId: string
  reason: string | null
  actorId: string
}

interface SlotFanoutBudget {
  remaining: number
}

export interface NotifiedCleanup {
  id: string
  title: string
}

export interface CleanupNotificationsDeps {
  repo: Pick<CleanupRepository, "listMemberIds">
  notifier?: Pick<NotificationService, "createNotification">
  attendeeNotifier?: { eventCancelled(cleanupId: string, reason: string | null): Promise<unknown> }
  jobs?: Jobs
  logger?: {
    warn(obj: unknown, msg?: string): void
    error(obj: unknown, msg?: string): void
  }
}

export interface CleanupNotifications {
  notifyRoleChange(
    targetUserId: string,
    event: "promoted" | "demoted" | "removed",
    cleanup: NotifiedCleanup,
  ): Promise<void>
  notifyCancellation(
    cleanup: NotifiedCleanup,
    reason: string | null,
    actorId: string,
  ): Promise<void>
  dispatchCancelFanout(
    cleanup: NotifiedCleanup,
    reason: string | null,
    actorId: string,
  ): Promise<void>
  dispatchGuestUpdateFanout(cleanupId: string): Promise<void>
  notifySlotChanges(cleanup: NotifiedCleanup, diff: SlotReconcileResult): Promise<void>
}

export function makeCleanupNotifications(deps: CleanupNotificationsDeps): CleanupNotifications {
  async function notifyRoleChange(
    targetUserId: string,
    event: "promoted" | "demoted" | "removed",
    cleanup: NotifiedCleanup,
  ): Promise<void> {
    if (deps.notifier === undefined) return
    try {
      await deps.notifier.createNotification(targetUserId, {
        type: "cleanup_role",
        titleKey: `notification.cleanup_role.${event}.title`,
        bodyKey: `notification.cleanup_role.${event}.body`,
        vars: { title: cleanup.title },
        link: `/cleanups/${cleanup.id}`,
      })
    } catch (err) {
      deps.logger?.warn(
        { err, targetUserId, cleanupId: cleanup.id, event },
        "cleanup_role notification failed (suppressed)",
      )
    }
  }

  async function notifyCancellation(
    cleanup: NotifiedCleanup,
    reason: string | null,
    actorId: string,
  ): Promise<void> {
    await notifyMembersOfCancellation(cleanup, reason, actorId)
    await notifyAttendeesOfCancellation(cleanup.id, reason)
  }

  async function notifyAttendeesOfCancellation(
    cleanupId: string,
    reason: string | null,
  ): Promise<void> {
    if (deps.attendeeNotifier === undefined) return
    await deps.attendeeNotifier.eventCancelled(cleanupId, reason)
  }

  async function dispatchGuestUpdateFanout(cleanupId: string): Promise<void> {
    if (deps.jobs === undefined) {
      deps.logger?.warn(
        { cleanupId },
        "cleanup.guest.update.fanout: no job queue wired; guests are not notified",
      )
      return
    }
    try {
      await deps.jobs.enqueue(
        CLEANUP_GUEST_UPDATE_FANOUT_JOB,
        { cleanupId } satisfies GuestUpdateFanoutJob,
        { singletonKey: cleanupId },
      )
    } catch (err) {
      deps.logger?.error(
        { err, cleanupId },
        "cleanup.guest.update.fanout enqueue failed; guests are not notified",
      )
    }
  }

  async function notifyMembersOfCancellation(
    cleanup: NotifiedCleanup,
    reason: string | null,
    actorId: string,
  ): Promise<void> {
    const notifier = deps.notifier
    if (notifier === undefined) return
    let memberIds: string[]
    try {
      memberIds = await deps.repo.listMemberIds(cleanup.id, CANCEL_FANOUT_MEMBER_CAP)
    } catch (err) {
      deps.logger?.warn(
        { err, cleanupId: cleanup.id },
        "cleanup_cancelled roster read failed (suppressed)",
      )
      return
    }
    const recipients = memberIds.filter((userId) => userId !== actorId)
    await mapWithLimit(recipients, CANCEL_FANOUT_CONCURRENCY, async (userId) => {
      try {
        await notifier.createNotification(userId, {
          type: "cleanup_cancelled",
          titleKey: "notification.cleanup_cancelled.title",
          bodyKey:
            reason !== null
              ? "notification.cleanup_cancelled.body_reason"
              : "notification.cleanup_cancelled.body",
          ...(reason !== null ? { vars: { reason } } : {}),
          link: `/cleanups/${cleanup.id}`,
          dedupeWindowMs: CANCEL_FANOUT_DEDUPE_WINDOW_MS,
        })
      } catch (err) {
        deps.logger?.warn(
          { err, cleanupId: cleanup.id, userId },
          "cleanup_cancelled notification failed (suppressed)",
        )
      }
    })
  }

  async function dispatchCancelFanout(
    cleanup: NotifiedCleanup,
    reason: string | null,
    actorId: string,
  ): Promise<void> {
    if (deps.jobs !== undefined) {
      try {
        await deps.jobs.enqueue(
          CLEANUP_CANCEL_FANOUT_JOB,
          { cleanupId: cleanup.id, reason, actorId } satisfies CleanupCancelFanoutJob,
          { singletonKey: cleanup.id },
        )
        return
      } catch (err) {
        deps.logger?.error(
          { err, cleanupId: cleanup.id },
          "cleanup.cancel.fanout enqueue failed; ringing members inline, guests are not notified",
        )
      }
    }
    try {
      await notifyMembersOfCancellation(cleanup, reason, actorId)
    } catch (err) {
      deps.logger?.warn(
        { err, cleanupId: cleanup.id },
        "cleanup_cancelled inline member fanout failed (suppressed; the cancellation itself stands)",
      )
    }
  }

  async function notifySlotClaimants(
    cleanup: NotifiedCleanup,
    entries: SlotReconcileResult["removed"],
    keys: { titleKey: MessageKey; bodyKey: MessageKey },
    budget: SlotFanoutBudget,
  ): Promise<void> {
    const notifier = deps.notifier
    if (notifier === undefined) return
    const targets: { userId: string; slot: string }[] = []
    for (const entry of entries) {
      for (const userId of entry.claimantUserIds) {
        if (budget.remaining <= 0) break
        budget.remaining -= 1
        targets.push({ userId, slot: entry.title })
      }
    }
    await mapWithLimit(targets, CANCEL_FANOUT_CONCURRENCY, async ({ userId, slot }) => {
      try {
        await notifier.createNotification(userId, {
          type: "cleanup_slot",
          titleKey: keys.titleKey,
          bodyKey: keys.bodyKey,
          vars: { slot, title: cleanup.title },
          link: `/cleanups/${cleanup.id}`,
        })
      } catch (err) {
        deps.logger?.warn(
          { err, cleanupId: cleanup.id, userId },
          "cleanup_slot notification failed (suppressed)",
        )
      }
    })
  }

  async function notifySlotChanges(
    cleanup: NotifiedCleanup,
    diff: SlotReconcileResult,
  ): Promise<void> {
    const budget: SlotFanoutBudget = { remaining: CANCEL_FANOUT_MEMBER_CAP }
    if (diff.removed.length > 0) {
      await notifySlotClaimants(
        cleanup,
        diff.removed,
        {
          titleKey: "notification.cleanup_slot.removed.title",
          bodyKey: "notification.cleanup_slot.removed.body",
        },
        budget,
      )
    }
    if (diff.rescheduled.length > 0) {
      await notifySlotClaimants(
        cleanup,
        diff.rescheduled,
        {
          titleKey: "notification.cleanup_slot.moved.title",
          bodyKey: "notification.cleanup_slot.moved.body",
        },
        budget,
      )
    }
  }

  return {
    notifyRoleChange,
    notifyCancellation,
    dispatchCancelFanout,
    dispatchGuestUpdateFanout,
    notifySlotChanges,
  }
}
