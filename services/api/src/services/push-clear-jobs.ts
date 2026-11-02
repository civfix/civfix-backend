import type { JobHandler } from "@civfix/seams"
import type { Container } from "../di.js"
import { MultiPushSender, type PushClearJob, type PushLogger } from "../adapters/push-sender.js"
import { PUSH_CLEAR_JOB } from "../lib/queue-names.js"

function parsePushClearJob(data: unknown): PushClearJob | null {
  if (typeof data !== "object" || data === null) return null
  const userId = (data as Record<string, unknown>).userId
  if (typeof userId !== "string" || userId.length === 0) return null
  return { userId }
}

export function makePushClearJobHandler(
  sender: Pick<MultiPushSender, "flushClears">,
  logger: Pick<PushLogger, "warn">,
): JobHandler {
  return async (job) => {
    const data = parsePushClearJob(job.data)
    if (data === null) {
      logger.warn({ jobId: job.id }, "push.clear: malformed job data (skipped)")
      return
    }
    await sender.flushClears(data.userId)
  }
}

export async function registerPushClearJob(
  container: Container,
  logger: Pick<PushLogger, "warn">,
): Promise<void> {
  // The fake sender records clears as made and never queues a job.
  const sender = container.pushSender
  if (!(sender instanceof MultiPushSender)) return
  await container.jobs.work(PUSH_CLEAR_JOB, makePushClearJobHandler(sender, logger))
}
