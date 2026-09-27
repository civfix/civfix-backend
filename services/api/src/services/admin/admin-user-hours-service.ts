import { AppError } from "@civfix/shared"
import type {
  AdminCreditUserHoursRequest,
  AdminCreditUserHoursResponse,
  AdminUserHoursEntryDTO,
  AdminUserHoursQuery,
  AdminUserHoursResponse,
  AdminVoidUserHoursRequest,
  AdminVoidUserHoursResponse,
} from "@civfix/shared"
import { isOfficialAccount } from "../../auth/official-account.js"
import {
  assertTargetIsNotOfficialAccount,
  assertTargetIsNotOperatorRole,
  isOperatorRole,
} from "../../auth/operator-target.js"
import { parseTimeCursor } from "../../db/cursor-helpers.js"
import type { CertificateRepository } from "../certificate-service.js"
import { eventDayKey } from "../host/event-day.js"
import { DEFAULT_EVENT_TIME_ZONE } from "../host/event-fields.js"
import type { InsightsInvalidator } from "../host/host-analytics-cache.js"
import type { NotificationService } from "../notification-service.js"
import { assertCreditableEventHours, assertEventCreditable } from "../volunteer-hours-rules.js"
import {
  DAILY_HOURS_CAP,
  HOURS_ENTRIES_DEFAULT_LIMIT,
  notifyHoursCredited,
  type CleanupHoursLookup,
  type OperatorLedgerEntryView,
  type VolunteerHoursRepository,
} from "../volunteer-hours-service.js"
import type { AdminAccountTarget, AdminUserRepository } from "./admin-user-service.js"

// A credited user who is not on the event roster cannot open the event page, so both bells link to
// the profile, where the Hours tab lists the new entry.
export const HOURS_CREDIT_NOTICE_LINK = "/profile"

export interface AdminUserHoursServiceDeps {
  hours: VolunteerHoursRepository
  certificates: Pick<CertificateRepository, "liveCodesListingEntry">
  accounts: Pick<AdminUserRepository, "findAccountTarget">
  events: Pick<CleanupHoursLookup, "load">
  insightsInvalidator?: InsightsInvalidator
  notifier?: Pick<NotificationService, "createNotification">
  logger?: { warn(obj: unknown, msg?: string): void }
  now?: () => Date
}

export interface AdminUserHoursService {
  getUserHours(query: AdminUserHoursQuery): Promise<AdminUserHoursResponse>
  creditUserHours(
    operatorId: string,
    request: AdminCreditUserHoursRequest,
  ): Promise<AdminCreditUserHoursResponse>
  voidUserHours(
    operatorId: string,
    request: AdminVoidUserHoursRequest,
  ): Promise<AdminVoidUserHoursResponse>
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function toAdminUserHoursEntryDTO(
  view: OperatorLedgerEntryView,
  accountAllowsVoid: boolean,
): AdminUserHoursEntryDTO {
  return {
    id: view.id,
    source: view.source,
    hours: round2(view.hours),
    occurredAt: view.occurredAt.toISOString(),
    creditedAt: view.createdAt.toISOString(),
    serviceDate: view.serviceDate,
    event:
      view.event === null
        ? null
        : { id: view.event.id, title: view.event.title, referenceCode: view.event.referenceCode },
    jurisdiction:
      view.jurisdiction === null
        ? null
        : { geoid: view.jurisdiction.geoid, name: view.jurisdiction.name },
    creditedBy:
      view.creditedBy === null
        ? null
        : {
            id: view.creditedBy.id,
            name: view.creditedBy.name,
            handle: view.creditedBy.handle,
            official: view.creditedBy.official,
          },
    operator: view.operator === null ? null : { id: view.operator.id, name: view.operator.name },
    note: view.note,
    voidedAt: view.voidedAt === null ? null : view.voidedAt.toISOString(),
    voidedBy: view.voidedBy === null ? null : { id: view.voidedBy.id, name: view.voidedBy.name },
    voidReason: view.voidReason,
    voidable: accountAllowsVoid && view.voidedAt === null && view.source !== "report",
  }
}

export function makeAdminUserHoursService(deps: AdminUserHoursServiceDeps): AdminUserHoursService {
  const now = deps.now ?? (() => new Date())

  async function accountOf(userId: string): Promise<AdminAccountTarget> {
    const target = await deps.accounts.findAccountTarget(userId)
    if (target === null) throw AppError.notFound("User not found")
    return target
  }

  async function assertCreditable(operatorId: string, userId: string): Promise<void> {
    assertTargetIsNotOfficialAccount(userId, "credit hours to")
    if (userId === operatorId) {
      throw AppError.forbidden("You can't credit volunteer hours to yourself.")
    }
    const target = await accountOf(userId)
    assertTargetIsNotOperatorRole(target.role, "credit hours to")
    if (target.deletedAt !== null) {
      throw AppError.conflict("This account was deleted, so no hours can be credited to it.")
    }
  }

  // A deleted account keeps its ledger (erasure unlists, it does not delete), and a bad credit on it
  // must stay correctable, so voiding skips the tombstone check that crediting applies.
  async function assertVoidable(userId: string): Promise<void> {
    assertTargetIsNotOfficialAccount(userId, "void the hours of")
    const target = await accountOf(userId)
    assertTargetIsNotOperatorRole(target.role, "void the hours of")
  }

  function assertServiceDateNotFuture(serviceDate: string): void {
    const today = eventDayKey(now(), DEFAULT_EVENT_TIME_ZONE)
    if (serviceDate > today) {
      throw AppError.validation({ serviceDate: "The service date can't be in the future." })
    }
  }

  async function creditEvent(
    operatorId: string,
    request: Extract<AdminCreditUserHoursRequest, { kind: "event" }>,
  ): Promise<string> {
    const event = await deps.events.load(request.eventId)
    if (event === null) throw AppError.notFound("Event not found")
    const limits = assertEventCreditable(event, now().getTime())
    assertCreditableEventHours(request.hours, limits, "hours")
    const hours = round2(request.hours)
    const { entryId } = await deps.hours.creditEventAsOperator({
      operatorId,
      userId: request.id,
      cleanupId: request.eventId,
      geoid: event.jurisdictionGeoid,
      hours,
      reason: request.reason,
      dailyCapHours: DAILY_HOURS_CAP,
    })
    await deps.insightsInvalidator?.bumpInsightsGeneration(request.eventId)
    await notifyHoursCredited(deps, [{ userId: request.id, hours }], {
      titleKey: "notification.hours_logged.title",
      bodyKey: "notification.hours_logged.body",
      vars: { title: event.title },
      link: HOURS_CREDIT_NOTICE_LINK,
      logContext: { cleanupId: request.eventId, entryId },
    })
    return entryId
  }

  async function creditManual(
    operatorId: string,
    request: Extract<AdminCreditUserHoursRequest, { kind: "manual" }>,
  ): Promise<string> {
    assertServiceDateNotFuture(request.serviceDate)
    const hours = round2(request.hours)
    const { entryId } = await deps.hours.creditManual({
      operatorId,
      userId: request.id,
      hours,
      serviceDate: request.serviceDate,
      reason: request.reason,
      dailyCapHours: DAILY_HOURS_CAP,
    })
    await notifyHoursCredited(deps, [{ userId: request.id, hours }], {
      titleKey: "notification.hours_adjusted.title",
      bodyKey: "notification.hours_adjusted.body",
      vars: {},
      link: HOURS_CREDIT_NOTICE_LINK,
      logContext: { entryId },
    })
    return entryId
  }

  return {
    async getUserHours(query: AdminUserHoursQuery): Promise<AdminUserHoursResponse> {
      const target = await accountOf(query.id)
      const accountAllowsVoid = !isOfficialAccount(query.id) && !isOperatorRole(target.role)
      const [page, totals] = await Promise.all([
        deps.hours.listOperatorLedger({
          userId: query.id,
          cursor: parseTimeCursor(query.cursor),
          limit: query.limit ?? HOURS_ENTRIES_DEFAULT_LIMIT,
        }),
        deps.hours.operatorLedgerTotals(query.id),
      ])
      return {
        items: page.items.map((view) => toAdminUserHoursEntryDTO(view, accountAllowsVoid)),
        nextCursor: page.nextCursor,
        totals,
      }
    },

    async creditUserHours(
      operatorId: string,
      request: AdminCreditUserHoursRequest,
    ): Promise<AdminCreditUserHoursResponse> {
      await assertCreditable(operatorId, request.id)
      const entryId =
        request.kind === "event"
          ? await creditEvent(operatorId, request)
          : await creditManual(operatorId, request)
      return { entryId, totalHours: await deps.hours.totalHoursFor(request.id) }
    },

    async voidUserHours(
      operatorId: string,
      request: AdminVoidUserHoursRequest,
    ): Promise<AdminVoidUserHoursResponse> {
      await assertVoidable(request.id)
      const voided = await deps.hours.voidEntry({
        operatorId,
        userId: request.id,
        entryId: request.entryId,
        reason: request.reason,
      })
      if (voided.source === "event" && voided.cleanupId !== null) {
        await deps.insightsInvalidator?.bumpInsightsGeneration(voided.cleanupId)
      }
      const certificates = await deps.certificates.liveCodesListingEntry(
        request.id,
        request.entryId,
      )
      return {
        ok: true,
        affectedCertificates: certificates.map((c) => ({
          code: c.code,
          issuedAt: c.issuedAt.toISOString(),
        })),
      }
    },
  }
}
