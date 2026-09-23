import {
  AppError,
  ErrorCode,
  MAX_EVENT_DURATION_MINUTES,
  MIN_EVENT_DURATION_MINUTES,
} from "@civfix/shared"
import type { CleanupStatus, EventSlotInput } from "@civfix/shared"
import {
  DEFAULT_EVENT_DURATION_MS,
  deriveCleanupStatus,
  eventEndsAtMs,
  hasEventEnded,
} from "@civfix/shared/host"
import type { EventWindowLike } from "@civfix/shared/host"

export { DEFAULT_EVENT_DURATION_MS, deriveCleanupStatus, eventEndsAtMs, hasEventEnded }

const MS_PER_MINUTE = 60 * 1000

const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE

export const SCHEDULE_MAX_BACKDATE_MS = MS_PER_DAY

export const DEFAULT_EVENT_SLOT_TITLE = "General volunteers"

export const EVENT_NEEDS_A_SLOT_MESSAGE = "an event needs at least one signup slot"

export function defaultEventSlot(capacity: number | null): EventSlotInput {
  return {
    title: DEFAULT_EVENT_SLOT_TITLE,
    description: null,
    capacity: capacity !== null && Number.isInteger(capacity) && capacity > 0 ? capacity : null,
    startsAt: null,
    endsAt: null,
    sortOrder: 0,
  }
}

export const MIN_EVENT_DURATION_MS = MIN_EVENT_DURATION_MINUTES * MS_PER_MINUTE

export const MAX_EVENT_DURATION_MS = MAX_EVENT_DURATION_MINUTES * MS_PER_MINUTE

export const SCHEDULE_MAX_AHEAD_MS = 2 * 365 * MS_PER_DAY

const EVENT_ENDED_FIELD = "event"

const EVENT_ENDED_REASON = "ended"

const EVENT_ENDED_MESSAGE = "This event has already ended."

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
