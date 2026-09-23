import { AppError } from "@civfix/shared"
import type { ContentReportSubject } from "@civfix/shared"
import type { Db, Sql } from "../db/client.js"
import {
  authorizePostBound,
  authorizeReportBound,
  makeDrizzleMediaViewAuthorizer,
} from "./media-authorization.js"
import {
  makeDrizzleMediaAuthorizationRepository,
  type MediaAuthorizationRepository,
} from "./media-authorization-repository.drizzle.js"
import { makeDrizzleMediaRepository } from "./media-repository.drizzle.js"
import { isPubliclyVisibleStatus } from "./report-visibility.js"
import { hasHostStanding, isEventPubliclyVisible } from "./host/authz.js"
import { hostStandingOf } from "./host/host-standing-repository.drizzle.js"

export interface ContentSubjectGate {
  assertReportable(
    subjectType: ContentReportSubject,
    subjectId: string,
    reporterUserId: string,
  ): Promise<void>
}

const SUBJECT_NOT_FOUND = "Content not found"

export function makeAllowAllContentSubjectGate(): ContentSubjectGate {
  return {
    assertReportable(): Promise<void> {
      return Promise.resolve()
    },
  }
}

export function makeDrizzleContentSubjectGate(sql: Sql, db: Db): ContentSubjectGate {
  const mediaRepo = makeDrizzleMediaRepository(db)
  const authzRepo = makeDrizzleMediaAuthorizationRepository(sql)
  const mediaAuthorizer = makeDrizzleMediaViewAuthorizer(sql)

  async function isVisibleToReporter(
    subjectType: ContentReportSubject,
    subjectId: string,
    reporterUserId: string,
  ): Promise<boolean> {
    switch (subjectType) {
      case "report":
        return (await authorizeReportBound(authzRepo, subjectId, reporterUserId)).allowed
      case "post":
        return (await authorizePostBound(authzRepo, subjectId, reporterUserId)).allowed
      case "message":
        return isChatMessageReportable(authzRepo, subjectId, reporterUserId)
      case "photo": {
        const asset = await mediaRepo.findById(subjectId)
        if (!asset || asset.status !== "ready") return false
        return (await mediaAuthorizer.authorize(asset, { userId: reporterUserId })).allowed
      }
      case "event": {
        // Same rule as the event detail read, so a private event's id is no existence oracle. A
        // cancelled event stays reportable, or a host could cancel to escape a report.
        const event = await hostStandingOf(sql, subjectId, reporterUserId)
        if (event === null) return false
        return hasHostStanding(event.standing) || isEventPubliclyVisible(event.visibility)
      }
      case "profile":
        return authzRepo.activeUserExists(subjectId)
      case "comment":
        return false
    }
  }

  return {
    async assertReportable(
      subjectType: ContentReportSubject,
      subjectId: string,
      reporterUserId: string,
    ): Promise<void> {
      const visible = await isVisibleToReporter(subjectType, subjectId, reporterUserId)
      if (!visible) throw AppError.notFound(SUBJECT_NOT_FOUND)
    },
  }
}

async function isChatMessageReportable(
  repo: MediaAuthorizationRepository,
  messageId: string,
  reporterUserId: string,
): Promise<boolean> {
  const dm = await repo.findDmMessageThread(messageId)
  if (dm) return repo.isDmParticipant(dm.threadId, reporterUserId)

  const msg = await repo.findChatMessageRoom(messageId)
  if (!msg) return false
  if (msg.cleanupId !== null) return repo.isCleanupMember(msg.cleanupId, reporterUserId)
  if (msg.groupId !== null) return isGroupMessageVisible(repo, msg.groupId, reporterUserId)
  if (msg.reportId !== null) return isReportChatVisible(repo, msg.reportId, reporterUserId)
  return false
}

async function isGroupMessageVisible(
  repo: MediaAuthorizationRepository,
  groupId: string,
  reporterUserId: string,
): Promise<boolean> {
  const group = await repo.findGroupAccess(groupId, reporterUserId)
  if (!group) return false
  return group.isMember || group.visibility === "public"
}

async function isReportChatVisible(
  repo: MediaAuthorizationRepository,
  reportId: string,
  reporterUserId: string,
): Promise<boolean> {
  const report = await repo.findReportAccess(reportId)
  if (!report || report.deletedAt !== null) return false
  if (isPubliclyVisibleStatus(report.status) && report.visibility === "public") return true
  return report.reporterUserId === reporterUserId
}
