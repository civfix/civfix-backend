import { AppError } from "@civfix/shared"
import type { ContentReportSubject } from "@civfix/shared"
import type { Db, Sql } from "../db/client.js"
import {
  authorizeChatBound,
  authorizePostBound,
  authorizeReportBound,
  makeDrizzleMediaViewAuthorizer,
} from "./media-authorization.js"
import { makeDrizzleMediaRepository } from "./media-repository.drizzle.js"

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
  const mediaAuthorizer = makeDrizzleMediaViewAuthorizer(sql)

  async function isVisibleToReporter(
    subjectType: ContentReportSubject,
    subjectId: string,
    reporterUserId: string,
  ): Promise<boolean> {
    switch (subjectType) {
      case "report":
        return (await authorizeReportBound(sql, subjectId, reporterUserId)).allowed
      case "post":
        return (await authorizePostBound(sql, subjectId, reporterUserId)).allowed
      case "message":
        return (await authorizeChatBound(sql, subjectId, reporterUserId)).allowed
      case "photo": {
        const asset = await mediaRepo.findById(subjectId)
        if (!asset || asset.status !== "ready") return false
        return (await mediaAuthorizer.authorize(asset, { userId: reporterUserId })).allowed
      }
      case "event": {
        const rows = await sql<{ ok: number }[]>`
          SELECT 1 AS ok FROM cleanups WHERE id = ${subjectId} LIMIT 1
        `
        return rows.length > 0
      }
      case "profile": {
        const rows = await sql<{ ok: number }[]>`
          SELECT 1 AS ok FROM users WHERE id = ${subjectId} AND deleted_at IS NULL LIMIT 1
        `
        return rows.length > 0
      }
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
