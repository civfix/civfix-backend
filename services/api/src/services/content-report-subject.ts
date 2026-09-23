import { AppError } from "@civfix/shared"
import type { ContentReportSubject } from "@civfix/shared"
import type { Db, Sql } from "../db/client.js"
import {
  authorizePostBound,
  authorizeReportBound,
  makeDrizzleMediaViewAuthorizer,
} from "./media-authorization.js"
import { makeDrizzleMediaRepository } from "./media-repository.drizzle.js"
import { isPubliclyVisibleStatus } from "./report-visibility.js"

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
        return isChatMessageReportable(sql, subjectId, reporterUserId)
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

async function isChatMessageReportable(
  sql: Sql,
  messageId: string,
  reporterUserId: string,
): Promise<boolean> {
  const dmRows = await sql<{ thread_id: string }[]>`
    SELECT thread_id FROM dm_messages WHERE id = ${messageId} LIMIT 1
  `
  const dm = dmRows[0]
  if (dm) {
    const member = await sql<{ ok: number }[]>`
      SELECT 1 AS ok FROM dm_threads
      WHERE id = ${dm.thread_id} AND (user_lo = ${reporterUserId} OR user_hi = ${reporterUserId})
      LIMIT 1
    `
    return member.length > 0
  }

  const chatRows = await sql<
    { cleanup_id: string | null; report_id: string | null; group_id: string | null }[]
  >`
    SELECT cleanup_id, report_id, group_id
    FROM chat_messages WHERE id = ${messageId} LIMIT 1
  `
  const msg = chatRows[0]
  if (!msg) return false

  if (msg.cleanup_id !== null) {
    const member = await sql<{ ok: number }[]>`
      SELECT 1 AS ok FROM cleanup_members
      WHERE cleanup_id = ${msg.cleanup_id} AND user_id = ${reporterUserId} LIMIT 1
    `
    return member.length > 0
  }

  if (msg.group_id !== null) {
    const rows = await sql<{ visibility: string; is_member: boolean }[]>`
      SELECT g.visibility,
             EXISTS (
               SELECT 1 FROM chat_group_members m
               WHERE m.group_id = g.id AND m.user_id = ${reporterUserId}
             ) AS is_member
      FROM chat_groups g WHERE g.id = ${msg.group_id} LIMIT 1
    `
    const group = rows[0]
    if (!group) return false
    return group.is_member || group.visibility === "public"
  }

  if (msg.report_id !== null) {
    const rows = await sql<
      {
        reporter_user_id: string | null
        status: string
        visibility: string
        deleted_at: Date | null
      }[]
    >`
      SELECT reporter_user_id, status, visibility, deleted_at
      FROM reports WHERE id = ${msg.report_id} LIMIT 1
    `
    const report = rows[0]
    if (!report || report.deleted_at !== null) return false
    if (isPubliclyVisibleStatus(report.status) && report.visibility === "public") return true
    return report.reporter_user_id === reporterUserId
  }

  return false
}
