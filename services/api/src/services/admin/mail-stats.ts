import type { MailStatsResponse } from "@civfix/shared"

export interface MailEventCounts {
  sent: number
  bounced: number
  failed: number
}

export function buildMailStats(input: {
  unread: number
  threads: number
  counts: MailEventCounts
}): MailStatsResponse {
  return {
    unread: Math.max(0, input.unread),
    threads: Math.max(0, input.threads),
    sent: Math.max(0, input.counts.sent),
    bounced: Math.max(0, input.counts.bounced),
    failed: Math.max(0, input.counts.failed),
  }
}
