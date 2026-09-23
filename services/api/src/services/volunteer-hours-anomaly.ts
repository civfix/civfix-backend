import type { VolunteerHoursAnomalyKind } from "./volunteer-hours-service.js"

export const HOURS_ANOMALY_FLAG = "Volunteer hours anomaly"

export const HOURS_ANOMALY_REASONS: Record<VolunteerHoursAnomalyKind, string> = {
  weekly_hours: "volunteer_hours.weekly_threshold",
  reciprocal_credit: "volunteer_hours.reciprocal_credit",
}

export interface HoursAnomalyInput {
  userId: string
  cleanupId: string
  kind: VolunteerHoursAnomalyKind
  counterpartUserId: string | null
  hours: number | null
}

export interface HoursAnomalyModerationItem {
  kind: "pattern"
  subjectType: "user"
  subjectId: string
  flag: string
  reason: string
  desc: string
  priority: "med"
  dedupeOpen: true
}

export function toHoursAnomalyModerationItem(input: HoursAnomalyInput): HoursAnomalyModerationItem {
  const desc =
    input.kind === "weekly_hours"
      ? `${round2(input.hours ?? 0)} volunteer hours credited to this account in the last 7 days; most recent credit on event ${input.cleanupId}.`
      : `Reciprocal crediting across events with ${input.counterpartUserId ?? "another account"}; most recent credit on event ${input.cleanupId}.`
  return {
    kind: "pattern",
    subjectType: "user",
    subjectId: input.userId,
    flag: HOURS_ANOMALY_FLAG,
    reason: HOURS_ANOMALY_REASONS[input.kind],
    desc,
    priority: "med",
    dedupeOpen: true,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
