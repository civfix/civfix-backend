import { AppError, MAX_EVENT_HOURS, MIN_EVENT_HOURS } from "@civfix/shared"
import type { CleanupStatus } from "@civfix/shared"
import { MIN_EVENT_DURATION_MS, eventWindowOf, hasEventEnded } from "./cleanup-rules.js"

export const EVENT_WINDOW_GRACE_MS = 60 * 60 * 1000

export interface EventHoursWindow {
  scheduledAt: Date
  endsAt: Date
  completedAt: Date | null
}

export interface CreditableEvent extends EventHoursWindow {
  status: CleanupStatus
}

export interface EventCreditLimits {
  durationMs: number
  windowCap: number
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function eventDurationMs(cleanup: EventHoursWindow): number {
  const end = cleanup.completedAt ?? cleanup.endsAt
  return end.getTime() - cleanup.scheduledAt.getTime()
}

export function creditableHoursForEvent(cleanup: EventHoursWindow): number {
  const windowMs = eventDurationMs(cleanup)
  if (windowMs <= 0) return 0
  const hours = (windowMs + EVENT_WINDOW_GRACE_MS) / (60 * 60 * 1000)
  return Math.min(MAX_EVENT_HOURS, Math.round(hours * 100) / 100)
}

export function assertEventCreditable(cleanup: CreditableEvent, nowMs: number): EventCreditLimits {
  if (cleanup.status === "cancelled") {
    throw AppError.conflict("Volunteer hours can't be logged for a cancelled event.")
  }
  if (!hasEventEnded(eventWindowOf(cleanup), nowMs)) {
    throw AppError.conflict("Volunteer hours can be logged once the event has ended.")
  }
  const durationMs = eventDurationMs(cleanup)
  if (durationMs < MIN_EVENT_DURATION_MS) {
    throw AppError.conflict(
      `This event ran for less than ${MIN_EVENT_DURATION_MS / 60_000} minutes, so no volunteer hours can be logged against it.`,
    )
  }
  return { durationMs, windowCap: creditableHoursForEvent(cleanup) }
}

export function assertCreditableEventHours(
  hours: number,
  limits: EventCreditLimits,
  field = "entries",
): void {
  if (!(hours >= MIN_EVENT_HOURS) || hours > MAX_EVENT_HOURS) {
    throw AppError.validation({
      [field]: `hours must be at least ${MIN_EVENT_HOURS} and at most ${MAX_EVENT_HOURS}`,
    })
  }
  if (hours > limits.windowCap) {
    throw AppError.validation({
      [field]: `this event ran for ${round2(limits.durationMs / 3_600_000)} h, so at most ${limits.windowCap} h may be credited per attendee`,
    })
  }
}

export function assertWithinDailyHoursCap(
  entries: readonly { userId: string; hours: number }[],
  heldByUser: ReadonlyMap<string, number>,
  dailyCapHours: number,
): void {
  for (const entry of entries) {
    const held = heldByUser.get(entry.userId) ?? 0
    if (held + entry.hours > dailyCapHours) {
      throw AppError.conflict(
        `That volunteer already holds ${round2(held)} h on this date; the daily limit is ${dailyCapHours} h.`,
      )
    }
  }
}
