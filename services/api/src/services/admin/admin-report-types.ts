import type {
  AdminReportDTO,
  AdminReportListQuery,
  AdminReportListResponse,
  AdminReportStatus,
  ReportMedia,
} from "@civfix/shared"
import type { OutboundMailService } from "./outbound-mail-service.js"
import type { FastifyBaseLogger } from "fastify"
import type { NotificationService } from "../notification-service.js"
import type { LinkedEventView } from "../cleanup-service.js"
import type { ReportChatSystemEmitter } from "../report-timeline-event.js"
import type { ForwardTemplateReader } from "./forward-template-repository.js"
import type { PresignPacketMedia } from "../media-presign.js"
import type { AdminReportRepository } from "./admin-report-repository.js"

export type ReporterNotifier = Pick<NotificationService, "createNotification">

export const REPORT_VERIFIED_THRESHOLD = 2

export function pickPreviewMedia<T extends { kind: "image" | "video" }>(
  media: readonly T[],
): T | null {
  return media.find((m) => m.kind === "image") ?? media[0] ?? null
}

export function previewThumbnailUrl(media: ReportMedia | null): string | null {
  if (media === null) return null
  return media.kind === "image" ? (media.thumbUrl ?? media.url) : (media.thumbUrl ?? null)
}

export interface AdminReportServiceDeps {
  repo: AdminReportRepository
  outboundMail: OutboundMailService
  presignMedia?: (
    r2Key: string,
    thumbKey: string | null,
  ) => Promise<{ url: string; thumbUrl?: string }>
  presignPacketMedia?: PresignPacketMedia
  loadLinkedEventsForReports?: (reportIds: string[]) => Promise<Map<string, LinkedEventView[]>>
  now?: () => Date
  reportChatEmitter?: ReportChatSystemEmitter
  forwardTemplates?: ForwardTemplateReader
  notifications?: ReporterNotifier
  logger?: Pick<FastifyBaseLogger, "warn">
}

export interface FollowupResult {
  to: "reporter" | "city"
  destination: string
}

export interface RouteToJurisdictionResult {
  threadId: string
  routedTo: string
}

export interface AdminReportService {
  list(query: AdminReportListQuery): Promise<AdminReportListResponse>
  get(id: string): Promise<AdminReportDTO>
  setStatus(id: string, input: { status: AdminReportStatus; actorId: string | null }): Promise<void>
  flag(id: string, input: { reason: string | null; actorId: string | null }): Promise<boolean>
  remove(id: string, input: { reason: string | null; actorId: string | null }): Promise<void>
  sendFollowup(
    id: string,
    input: { to: "reporter" | "city"; body: string; actorId: string | null },
  ): Promise<FollowupResult>
  routeToJurisdiction(
    id: string,
    input: { note: string | null; actorId: string | null },
  ): Promise<RouteToJurisdictionResult>
  setVerdict(input: {
    id: string
    verdict: "approved" | "rejected"
    actorId: string | null
  }): Promise<void>
}
