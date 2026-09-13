import { AppError, ErrorCode } from "@civfix/shared"
import type { CleanupStatus } from "@civfix/shared"

export const SCHEDULE_MAX_BACKDATE_MS = 24 * 60 * 60 * 1000

export const MIN_EVENT_DURATION_MS = 15 * 60 * 1000
export const SCHEDULE_MAX_AHEAD_MS = 2 * 365 * 24 * 60 * 60 * 1000

export const IN_PROGRESS_GRACE_HOURS = 24

export const IN_PROGRESS_GRACE_MS = IN_PROGRESS_GRACE_HOURS * 60 * 60 * 1000

export const EVENT_ENDED_FIELD = "event"

export const EVENT_ENDED_REASON = "ended"

export const EVENT_ENDED_MESSAGE = "This event has already ended."

export function eventEndedError(): AppError {
  return new AppError(ErrorCode.CONFLICT, EVENT_ENDED_MESSAGE, {
    fields: { [EVENT_ENDED_FIELD]: EVENT_ENDED_REASON },
  })
}

export function isCleanupTerminal(status: CleanupStatus): boolean {
  return status === "done" || status === "cancelled"
}

export interface EventWindow {
  scheduledAt: Date
  endsAt: Date | null
}

export function eventEndsAt(window: EventWindow): Date {
  return window.endsAt ?? new Date(window.scheduledAt.getTime() + IN_PROGRESS_GRACE_MS)
}

export function hasEventEnded(window: EventWindow, now: Date): boolean {
  return eventEndsAt(window).getTime() < now.getTime()
}
