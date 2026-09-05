import type { CleanupStatus } from "@civfix/shared"

export const SCHEDULE_MAX_BACKDATE_MS = 24 * 60 * 60 * 1000

export const MIN_EVENT_DURATION_MS = 15 * 60 * 1000
export const SCHEDULE_MAX_AHEAD_MS = 2 * 365 * 24 * 60 * 60 * 1000

export function isCleanupTerminal(status: CleanupStatus): boolean {
  return status === "done" || status === "cancelled"
}
