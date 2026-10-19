import type { Sql } from "../../db/client.js"
import type { FilingRepository } from "./filing-repository.js"

export function makeDrizzleFilingRepository(_sql: Sql): FilingRepository {
  const notImplemented = (): never => {
    throw new Error("not implemented")
  }
  return {
    create: notImplemented,
    getById: notImplemented,
    getActiveForReport: notImplemented,
    getLatestSuccessfulForReport: notImplemented,
    getLatestSuccessfulForReports: notImplemented,
    transition: notImplemented,
    recordSuccess: notImplemented,
    claim: notImplemented,
    list: notImplemented,
    countGroups: notImplemented,
    listDueQueued: notImplemented,
    listRunningFilings: notImplemented,
    getLatestByMailThread: notImplemented,
    listEvidence: notImplemented,
    listRoutes: notImplemented,
    findRoutes: notImplemented,
    replaceRoutes: notImplemented,
    routeHealth: notImplemented,
    getSettings: notImplemented,
    setPaused: notImplemented,
    insertMessageIfAbsent: notImplemented,
    getMessageByInboundEmailId: notImplemented,
    getMessageByMailMessageId: notImplemented,
    flagMessage: notImplemented,
    findByCaseIds: notImplemented,
  }
}
