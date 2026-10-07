import type { Container } from "../di.js"
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import type { CleanupHoursLookup } from "../services/volunteer-hours-service.js"

export function makeCleanupHoursLookup(container: Container): CleanupHoursLookup {
  return {
    async load(cleanupId: string) {
      const record = await makeDrizzleCleanupRepository(container.getDb().sql).findCleanupById(
        cleanupId,
        null,
      )
      if (!record) return null
      return {
        organizerUserId: record.organizerUserId,
        status: record.status,
        visibility: record.visibility,
        jurisdictionGeoid: record.jurisdictionGeoid,
        title: record.title,
        scheduledAt: record.scheduledAt,
        endsAt: record.endsAt,
        completedAt: record.completedAt,
        timezone: record.timezone,
      }
    },
    listMemberIds: (cleanupId: string, limit: number) =>
      makeDrizzleCleanupRepository(container.getDb().sql).listMemberIds(cleanupId, limit),
    roleOf: (cleanupId: string, userId: string) =>
      makeDrizzleCleanupRepository(container.getDb().sql).roleOf(cleanupId, userId),
    async standingOf(cleanupId: string, userId: string) {
      return makeDrizzleCleanupRepository(container.getDb().sql).standingOf(cleanupId, userId)
    },
  }
}
