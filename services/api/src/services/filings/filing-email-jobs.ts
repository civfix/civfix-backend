import type { JobHandler, Storage } from "@civfix/seams"
import type { AdminReportRepository } from "../admin/admin-report-repository.js"
import type { ForwardTemplateReader } from "../admin/forward-template-repository.js"
import type { MailRepository } from "../admin/mail-repository.js"
import type { OutboundMailService } from "../admin/outbound-mail-service.js"
import type { PresignPacketMedia } from "../media-presign.js"
import type { FilingRepository } from "./filing-repository.js"
import type { FilingService } from "./filing-service.js"

export interface FilingEmailLogger {
  warn(obj: unknown, msg?: string): void
}

export interface FilingEmailDeps {
  filings: Pick<FilingRepository, "getById" | "getSettings" | "claim" | "transition">
  reports: Pick<
    AdminReportRepository,
    "getReport" | "getRouting" | "listMedia" | "getOutreach" | "withRouteLock"
  >
  mail: Pick<MailRepository, "latestUnsentPacketId">
  outboundMail: Pick<OutboundMailService, "prepareReportToJurisdiction" | "redeliverReportPacket">
  storage: Pick<Storage, "getObject">
  presignPacketMedia: PresignPacketMedia
  forwardTemplates?: ForwardTemplateReader
  filingService: Pick<FilingService, "applyFilingSuccess">
  logger: FilingEmailLogger
}

export function makeFilingEmailHandler(_deps: FilingEmailDeps): JobHandler {
  return () => Promise.reject(new Error("not implemented"))
}
