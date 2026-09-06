import type { Jobs } from "@civfix/shared/interfaces"
import { WAITLIST_PROMOTE_JOB } from "./registration-queues.js"

export interface WaitlistPromotionLogger {
  warn(obj: unknown, msg?: string): void
}

export async function enqueueWaitlistPromotion(
  jobs: Jobs | undefined,
  ticketTypeIds: readonly (string | null)[],
  logger?: WaitlistPromotionLogger,
): Promise<void> {
  if (jobs === undefined) return
  const ids = [...new Set(ticketTypeIds.filter((id): id is string => id !== null && id.length > 0))]
  for (const ticketTypeId of ids) {
    try {
      await jobs.enqueue(WAITLIST_PROMOTE_JOB, { ticketTypeId }, { singletonKey: ticketTypeId })
    } catch (err) {
      logger?.warn({ err, ticketTypeId }, "waitlist promote: enqueue failed (suppressed)")
    }
  }
}
