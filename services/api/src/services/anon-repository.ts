import type {
  AddressPrecision,
  AnonReportResponse,
  GeomSource,
  ReportAddressSource,
  ReportCategory,
  ReportStatus,
  ReportType,
} from "@civfix/shared"
import type { AnonTokenStore } from "../abuse/anon-token.js"
import type { AnonAbuseReason } from "./anon-service.js"

export interface CreateAnonReportTxArgs {
  reportId: string
  anonSessionId: string
  idempotencyKey: string
  lat: number
  lng: number
  geomSource: GeomSource
  jurisdictionGeoid: string | null
  jurCode: number
  category: ReportCategory
  type: ReportType
  title: string | null
  description: string | null
  addr: string | null
  addrSource: ReportAddressSource | null
  addrPrecision: AddressPrecision | null
  h3Cell: string
  mediaUploadIds: string[]
  mediaUploaders: readonly string[]
  claimCodeHash: string
  reportCap: number
  responseSnapshot: AnonReportResponse
}

export type CreateAnonReportTxResult =
  | { kind: "created"; snapshot: AnonReportResponse }
  | { kind: "replayed"; snapshot: AnonReportResponse }

export interface AnonReportStatusRow {
  reportId: string
  status: ReportStatus
  publishedAt: Date | null
  claimCodeHash: string | null
}

export interface AnonReportRepository extends AnonTokenStore {
  findIdempotentSnapshot(
    key: string,
    scope: string,
    userOrAnon: string | null,
  ): Promise<AnonReportResponse | null>
  createAnonReportTx(args: CreateAnonReportTxArgs): Promise<CreateAnonReportTxResult>
  findAnonReportStatus(reportId: string): Promise<AnonReportStatusRow | null>
}

export interface PendingAnonReport {
  reportId: string
}

export interface ClaimRepository extends AnonTokenStore {
  rotatePendingClaimCode(tokenId: string, claimCodeHash: string): Promise<PendingAnonReport | null>
  claimByCode(claimCodeHash: string, userId: string): Promise<{ reportId: string } | null>
}

export interface DrizzleAnonReportRepository extends AnonReportRepository {
  raiseAbuseFlag(
    subjectType: "report" | "anon_token",
    subjectId: string,
    reason: AnonAbuseReason,
  ): Promise<void>
}
