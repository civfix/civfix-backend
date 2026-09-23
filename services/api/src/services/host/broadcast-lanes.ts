import type { BroadcastChannel } from "@civfix/shared"
import type { FastifyBaseLogger } from "fastify"
import type { CounterStore } from "../../abuse/counter-store.js"
import type { BroadcastRepository } from "./broadcast-repository.js"
import type { BroadcastCreateInput, EventBroadcastContext } from "./broadcast-types.js"
import { verifiedReplyTo } from "./broadcast-render.js"
import { eventWindowOf, hasEventEnded } from "../cleanup-rules.js"
import { MS_PER_HOUR, MS_PER_SECOND } from "../../lib/time.js"

export const DEFAULT_REMINDER_OFFSETS_MIN = [1440, 180] as const

const REMINDER_STALE_HOURS = 6

const REMINDER_SWEEP_LIMIT = 200

const AUTOMATED_CHANNELS: BroadcastChannel[] = ["inapp", "push", "email"]

const EVENT_UPDATE_WINDOW_SEC = MS_PER_HOUR / MS_PER_SECOND
// An ISO timestamp cut to "YYYY-MM-DDTHH" names the UTC hour the throttle window counts in.
const ISO_HOUR_LENGTH = 13

type AutomatedKind = "event_updated" | "event_cancelled" | "reminder"

function automatedBroadcast(
  event: EventBroadcastContext,
  kind: AutomatedKind,
  subject: string,
  bodyMd: string,
  startedAt: Date,
): BroadcastCreateInput {
  return {
    cleanupId: event.cleanupId,
    createdBy: null,
    kind,
    subject,
    bodyMd,
    segment: { kind: "all_registered" },
    channels: AUTOMATED_CHANNELS,
    status: "sending",
    startedAt,
    replyTo: verifiedReplyTo(event),
  }
}

export type EventUpdateVerdict =
  | { status: "started"; broadcastId: string }
  | { status: "throttled"; retryAfterSec: number }
  | { status: "skipped" }

export interface BroadcastLaneDeps {
  repo: BroadcastRepository
  counters: CounterStore
  perEventPerHour: number
  enqueuePlan: (broadcastId: string) => Promise<void>
  logger?: Pick<FastifyBaseLogger, "info" | "warn" | "error">
  now?: () => Date
}

export function makeBroadcastLanes(deps: BroadcastLaneDeps) {
  const now = deps.now ?? (() => new Date())

  function secondsToWindowEnd(at: Date): number {
    const nextHourMs = Math.floor(at.getTime() / MS_PER_HOUR) * MS_PER_HOUR + MS_PER_HOUR
    return Math.max(1, Math.ceil((nextHourMs - at.getTime()) / MS_PER_SECOND))
  }

  async function reserveEventUpdateSlot(cleanupId: string): Promise<boolean> {
    const hourKey = now().toISOString().slice(0, ISO_HOUR_LENGTH)
    try {
      const used = await deps.counters.incr(
        `bcast:evupd:${cleanupId}:${hourKey}`,
        EVENT_UPDATE_WINDOW_SEC,
      )
      if (used <= deps.perEventPerHour) return true
      deps.logger?.warn(
        { evt: "broadcast.event_updated.throttled", cleanupId, used },
        "event_updated lane throttled: this event already announced changes this hour",
      )
      return false
    } catch (err) {
      deps.logger?.warn(
        { err, cleanupId },
        "event_updated throttle counter unavailable; refusing the lane (fail closed)",
      )
      return false
    }
  }

  /**
   * A retry lands here when an earlier attempt inserted the row but failed to enqueue its plan.
   * Re-enqueueing cannot double-send: plan() only acts on a 'sending' row and deliveries are unique
   * per recipient and channel. Without it the notice would wait for the stale-sending sweep.
   */
  async function replanUnplannedCancellation(cleanupId: string): Promise<void> {
    const existing = await deps.repo.findEventCancellation(cleanupId)
    if (existing !== null && existing.status === "sending" && existing.plannedAt === null) {
      deps.logger?.warn(
        { evt: "broadcast.event_cancelled.replanned", cleanupId, broadcastId: existing.id },
        "event_cancelled lane found its broadcast unplanned; enqueueing the plan again",
      )
      await deps.enqueuePlan(existing.id)
      return
    }
    deps.logger?.info(
      { evt: "broadcast.event_cancelled.deduped", cleanupId },
      "event_cancelled lane skipped: this event already has a cancellation broadcast",
    )
  }

  return {
    async eventUpdated(cleanupId: string): Promise<EventUpdateVerdict> {
      const event = await deps.repo.eventContext(cleanupId)
      if (event === null) return { status: "skipped" }
      const window = eventWindowOf({ scheduledAt: event.scheduledAt, endsAt: event.endsAt })
      if (event.status === "cancelled" || hasEventEnded(window, now().getTime())) {
        return { status: "skipped" }
      }
      if (!(await reserveEventUpdateSlot(cleanupId))) {
        return { status: "throttled", retryAfterSec: secondsToWindowEnd(now()) }
      }
      const record = await deps.repo.create(
        automatedBroadcast(
          event,
          "event_updated",
          `${event.title} has new details`,
          `The details for **${event.title}** have changed. Open the event to see what is different and confirm you can still make it.`,
          now(),
        ),
      )
      await deps.enqueuePlan(record.id)
      return { status: "started", broadcastId: record.id }
    },

    async eventCancelled(cleanupId: string, reason: string | null): Promise<string | null> {
      const event = await deps.repo.eventContext(cleanupId)
      if (event === null) return null
      const body =
        reason !== null && reason.trim().length > 0
          ? `**${event.title}** has been cancelled by the organizer.\n\nReason: ${reason.trim()}`
          : `**${event.title}** has been cancelled by the organizer.`
      const record = await deps.repo.createIfAbsent(
        automatedBroadcast(
          event,
          "event_cancelled",
          `${event.title} has been cancelled`,
          body,
          now(),
        ),
      )
      if (record === null) {
        await replanUnplannedCancellation(cleanupId)
        return null
      }
      await deps.enqueuePlan(record.id)
      return record.id
    },

    async runReminderSweep(): Promise<{ created: number }> {
      const at = now()
      const due = await deps.repo.listDueReminders({
        now: at,
        staleAfter: new Date(at.getTime() - REMINDER_STALE_HOURS * MS_PER_HOUR),
        defaultOffsets: DEFAULT_REMINDER_OFFSETS_MIN,
        limit: REMINDER_SWEEP_LIMIT,
      })
      let created = 0
      for (const reminder of due) {
        const event = await deps.repo.eventContext(reminder.cleanupId)
        if (event === null) continue
        const record = await deps.repo.createIfAbsent({
          ...automatedBroadcast(
            event,
            "reminder",
            `Reminder: ${event.title}`,
            `**${event.title}** is coming up. Check the event page for the meeting point and what to bring.`,
            at,
          ),
          reminderOffsetMin: reminder.offsetMin,
        })
        if (record === null) continue
        created += 1
        await deps.enqueuePlan(record.id)
      }
      deps.logger?.info({ evt: "broadcast.reminders.done", created }, "reminder sweep complete")
      return { created }
    },
  }
}

export type BroadcastLanes = ReturnType<typeof makeBroadcastLanes>
