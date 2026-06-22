/**
 * Pure deliverability math for the mail domain (service-owned; not persistence). The repo returns raw
 * rolling-window event counts; these derive the domain-health summary + the placement/bounce/complaint
 * rates. No I/O.
 */

import type { MailStatsResponse } from "@civfix/shared"

/**
 * Build the domainHealth[] summary from rolling-window event counts (the three civfix sending surfaces).
 * Status is derived honestly: any bounce/complaint downgrades the sending domain to "warn" (or "bad" past
 * a small threshold); with no events everything reports a neutral "ok" baseline (we don't claim a problem
 * we have no signal for).
 */
export function buildDomainHealth(
  replyDomain: string,
  counts: { delivered: number; bounced: number; complained: number },
): MailStatsResponse["domainHealth"] {
  const { bounced, complained } = counts
  const sendingStatus: "ok" | "warn" | "bad" =
    bounced + complained === 0 ? "ok" : bounced + complained >= 5 ? "bad" : "warn"
  const sendingNote =
    sendingStatus === "ok"
      ? "No bounces or complaints in the last 7 days."
      : `${bounced} bounced, ${complained} complained in the last 7 days.`
  return [
    { domain: "civfix.org", status: sendingStatus, note: sendingNote },
    { domain: replyDomain, status: "ok", note: "Reply routing healthy." },
    {
      domain: "OCI Email Delivery",
      status: bounced + complained >= 5 ? "warn" : "ok",
      note: "Outbound relay reachable.",
    },
  ]
}

/**
 * Deliverability rates from rolling-window counts. placement7d is the inbox-placement proxy
 * (delivered / sent); bounceRate / complaintRate are over sent. All default to safe values when there is
 * no `sent` signal (placement 1, rates 0) rather than dividing by zero.
 */
export function computeRates(counts: {
  sent: number
  delivered: number
  bounced: number
  complained: number
}): { placement7d: number; bounceRate: number; complaintRate: number } {
  const denom = counts.sent > 0 ? counts.sent : 0
  if (denom === 0) {
    return { placement7d: 1, bounceRate: 0, complaintRate: 0 }
  }
  return {
    placement7d: counts.delivered / denom,
    bounceRate: counts.bounced / denom,
    complaintRate: counts.complained / denom,
  }
}
