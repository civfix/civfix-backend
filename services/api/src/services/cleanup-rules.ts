import {
  AppError,
  ErrorCode,
  MAX_EVENT_DURATION_MINUTES,
  MIN_EVENT_DURATION_MINUTES,
} from "@civfix/shared"
import type { CleanupStatus } from "@civfix/shared"
import {
  DEFAULT_EVENT_DURATION_MS,
  deriveCleanupStatus,
  eventEndsAtMs,
  hasEventEnded,
  hasEventStarted,
} from "@civfix/shared/host"
import type { EventWindowLike } from "@civfix/shared/host"

export {
  DEFAULT_EVENT_DURATION_MS,
  deriveCleanupStatus,
  eventEndsAtMs,
  hasEventEnded,
  hasEventStarted,
}
export type { EventWindowLike }

export const SCHEDULE_MAX_BACKDATE_MS = 24 * 60 * 60 * 1000

export const DEFAULT_EVENT_SLOT_TITLE = "General volunteers"

export const EVENT_NEEDS_A_SLOT_MESSAGE = "An event needs at least one signup slot."

export const MIN_EVENT_DURATION_MS = MIN_EVENT_DURATION_MINUTES * 60 * 1000

export const MAX_EVENT_DURATION_MS = MAX_EVENT_DURATION_MINUTES * 60 * 1000

export const SCHEDULE_MAX_AHEAD_MS = 2 * 365 * 24 * 60 * 60 * 1000

export const EVENT_ENDED_FIELD = "event"

export const EVENT_ENDED_REASON = "ended"

export const EVENT_ENDED_MESSAGE = "This event has already ended."

export function eventEndedError(): AppError {
  return new AppError(ErrorCode.CONFLICT, EVENT_ENDED_MESSAGE, {
    fields: { [EVENT_ENDED_FIELD]: EVENT_ENDED_REASON },
  })
}

export interface EventWindow {
  status?: CleanupStatus
  scheduledAt: Date
  endsAt: Date | null
}

export function eventWindowOf(window: EventWindow): EventWindowLike {
  return {
    status: window.status ?? "upcoming",
    scheduledAt: window.scheduledAt.toISOString(),
    endsAt: window.endsAt === null ? null : window.endsAt.toISOString(),
  }
}

export function eventWindowOfRow(row: {
  status: CleanupStatus
  scheduled_at: Date
  ends_at: Date | null
}): EventWindowLike {
  return eventWindowOf({
    status: row.status,
    scheduledAt: row.scheduled_at,
    endsAt: row.ends_at,
  })
}
