import type { CounterStore } from "../../abuse/counter-store.js"
import type { Container } from "../../di.js"
import type { Sql } from "../../db/client.js"
import { makeMediaPresigner } from "../media-presign.js"
import { makeGuestPromotionNotifier, type GuestPromotionNotifier } from "../guest-notify.js"
import { webBaseUrlOf } from "../../lib/base-url.js"
import { makeDrizzleGuestRsvpRepository } from "../guest-rsvp-repository.drizzle.js"
import { writeAudit } from "../admin/audit.js"
import type { HostCapability } from "@civfix/shared"
import { can, type HostStanding } from "@civfix/shared/host"
import { hostStandingOf } from "./host-standing.js"
import {
  makeInsightsGeneration,
  NOOP_INSIGHTS_INVALIDATOR,
  type InsightsInvalidator,
} from "./host-analytics-cache.js"
import { requireCapability, resolveVisibleStanding } from "./authz.js"
import { makeCheckinService, type CheckinService } from "./checkin-service.js"
import { makePageService, type PageService } from "./page-service.js"
import { makeQuestionService, type QuestionService } from "./question-service.js"
import { makeDrizzleHostRegistrationRepository } from "./registration-repository.drizzle.js"
import { hostTeamUserIds } from "./registration-sql.js"
import {
  HOST_TEAM_SIGNAL_CAP,
  makeRegistrationService,
  type RegistrationAudit,
  type RegistrationNotifier,
  type RegistrationService,
} from "./registration-service.js"
import { makeTicketTypeService, type TicketTypeService } from "./ticket-type-service.js"
import { makeWaitlistService, type WaitlistService } from "./waitlist-service.js"
import type { TicketTokenSigner } from "./ticket-token.js"
import type { HostRegistrationRepository } from "./registration-repository.types.js"

export interface HostServiceLogger {
  warn(obj: unknown, msg?: string): void
  info(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

const TRAILING_SLASHES = /\/+$/

export interface HostRegistrationOverrides {
  guards?: HostGuards
  counters?: CounterStore
  repo?: HostRegistrationRepository
  tokens?: TicketTokenSigner
  guestByManageToken?: (
    hash: string,
  ) => Promise<{ id: string; cleanupId: string; cancelledAt: Date | null } | null>
  teamUserIds?: (cleanupId: string) => Promise<string[]>
  insightsInvalidator?: InsightsInvalidator
  audit?: RegistrationAudit
  now?: () => Date
  newId?: () => string
}

export interface HostPageOverrides {
  guards?: HostGuards
  counters?: CounterStore
  repo?: HostRegistrationRepository
  presignCover?: (r2Key: string) => Promise<{ url: string }>
  standingOf?: (cleanupId: string, userId: string | null) => Promise<HostStanding | null>
  now?: () => Date
}

export interface HostRegistrationServices {
  repo: HostRegistrationRepository
  tokens: TicketTokenSigner
  tickets: TicketTypeService
  questions: QuestionService
  registrations: RegistrationService
  waitlist: WaitlistService
  checkin: CheckinService
}

function platformMediaUrlPrefixes(container: Container): string[] {
  const bases = [container.env.R2_PUBLIC_BASE ?? "", container.env.PUBLIC_API_URL]
  return bases
    .map((base) => base.trim().replace(TRAILING_SLASHES, ""))
    .filter((base) => base.length > 0)
    .map((base) => `${base}/`)
}

function lazyNotifier(container: Container, logger?: HostServiceLogger): RegistrationNotifier {
  return {
    createNotification: (userId, input) =>
      container
        .getNotificationService(logger as Parameters<Container["getNotificationService"]>[0])
        .createNotification(userId, input),
  }
}

function auditWriter(sql: Sql, logger?: HostServiceLogger): RegistrationAudit {
  return async (input) => {
    try {
      await writeAudit(sql, {
        actorId: input.actorId,
        action: input.action,
        target: input.target,
        meta: input.meta ?? null,
      })
    } catch (err) {
      logger?.warn({ err, action: input.action }, "host audit: write failed (suppressed)")
    }
  }
}

type GuestTicketLookup = NonNullable<HostRegistrationOverrides["guestByManageToken"]>

interface ResolvedRegistrationDeps {
  sql: Sql | undefined
  repo: HostRegistrationRepository
  tokens: TicketTokenSigner
  audit: RegistrationAudit | undefined
  teamUserIds: ((cleanupId: string) => Promise<string[]>) | undefined
  guestByManageToken: GuestTicketLookup | undefined
  notifier: RegistrationNotifier
  guests: GuestPromotionNotifier | undefined
  counters: CounterStore
  insightsInvalidator: InsightsInvalidator
}

function guestByManageTokenIn(sql: Sql): GuestTicketLookup {
  return async (hash: string) => {
    const rows = await sql<{ id: string; cleanup_id: string; cancelled_at: Date | null }[]>`
      SELECT id, cleanup_id, cancelled_at FROM cleanup_guests
       WHERE manage_token_hash = ${hash}
       LIMIT 1
    `
    const row = rows[0]
    return row === undefined
      ? null
      : { id: row.id, cleanupId: row.cleanup_id, cancelledAt: row.cancelled_at }
  }
}

// A repo override means an offline test harness: nothing that would open the database is built then.
function resolveRegistrationDeps(
  container: Container,
  overrides: HostRegistrationOverrides | undefined,
  logger: HostServiceLogger | undefined,
): ResolvedRegistrationDeps {
  const sql = overrides?.repo === undefined ? container.getDb().sql : undefined
  const repo = overrides?.repo ?? makeDrizzleHostRegistrationRepository(sql as Sql)
  const tokens = overrides?.tokens ?? container.getTicketTokenSigner()
  const audit = overrides?.audit ?? (sql === undefined ? undefined : auditWriter(sql, logger))
  const teamUserIds =
    overrides?.teamUserIds ??
    (sql === undefined
      ? undefined
      : (cleanupId: string) => hostTeamUserIds(sql, cleanupId, HOST_TEAM_SIGNAL_CAP))
  const guestByManageToken =
    overrides?.guestByManageToken ?? (sql === undefined ? undefined : guestByManageTokenIn(sql))
  const notifier = lazyNotifier(container, logger)
  const guests =
    sql === undefined
      ? undefined
      : makeGuestPromotionNotifier({
          repo: makeDrizzleGuestRsvpRepository(sql),
          mailer: container.mailer,
          linkBase: webBaseUrlOf(container.env),
        })
  const counters = overrides?.counters ?? container.getCounterStore()
  const insightsInvalidator: InsightsInvalidator =
    overrides?.insightsInvalidator ??
    (sql === undefined
      ? NOOP_INSIGHTS_INVALIDATOR
      : makeInsightsGeneration({
          cache: container.getCache(),
          ...(logger !== undefined ? { logger } : {}),
        }))
  return {
    sql,
    repo,
    tokens,
    audit,
    teamUserIds,
    guestByManageToken,
    notifier,
    guests,
    counters,
    insightsInvalidator,
  }
}

export function makeContainerRegistrationServices(
  container: Container,
  overrides: HostRegistrationOverrides | undefined,
  logger?: HostServiceLogger,
): HostRegistrationServices {
  const deps = resolveRegistrationDeps(container, overrides, logger)
  const { repo, tokens, notifier, counters, insightsInvalidator } = deps
  const clock = overrides?.now !== undefined ? { now: overrides.now } : {}
  const log = logger !== undefined ? { logger } : {}
  const audit = deps.audit !== undefined ? { audit: deps.audit } : {}

  const registrations = makeRegistrationService({
    repo,
    tokens,
    jobs: container.jobs,
    notifier,
    userChannel: container.userChannel,
    counters,
    ...audit,
    insightsInvalidator,
    ...(deps.teamUserIds !== undefined ? { teamUserIds: deps.teamUserIds } : {}),
    ...(deps.sql === undefined ? {} : { affiliations: container.getAffiliationLoader() }),
    ...clock,
    ...(overrides?.newId !== undefined ? { newId: overrides.newId } : {}),
    ...log,
  })

  return {
    repo,
    tokens,
    registrations,
    tickets: makeTicketTypeService({
      repo,
      jobs: container.jobs,
      counters,
      insightsInvalidator,
      ...clock,
      ...log,
    }),
    questions: makeQuestionService({ repo, ...clock }),
    waitlist: makeWaitlistService({
      repo,
      registrations,
      jobs: container.jobs,
      notifier,
      ...(deps.guests !== undefined ? { guests: deps.guests } : {}),
      ...audit,
      ...clock,
      ...log,
    }),
    checkin: makeCheckinService({
      repo,
      tokens,
      registrations,
      ...(container.env.PUBLIC_API_URL.length > 0
        ? { publicApiUrl: container.env.PUBLIC_API_URL }
        : {}),
      ...(deps.guestByManageToken !== undefined
        ? { guestByManageToken: deps.guestByManageToken }
        : {}),
      ...audit,
      ...clock,
      ...log,
    }),
  }
}

export function makeContainerPageService(
  container: Container,
  overrides: HostPageOverrides | undefined,
  logger?: HostServiceLogger,
): PageService {
  const sql = overrides?.repo === undefined ? container.getDb().sql : undefined
  const repo = overrides?.repo ?? makeDrizzleHostRegistrationRepository(sql as Sql)
  const presign = makeMediaPresigner(container.storage)
  const presignCover = overrides?.presignCover ?? (async (r2Key: string) => presign(r2Key, null))
  const counters = overrides?.counters ?? container.getCounterStore()
  const standingOf =
    overrides?.standingOf ??
    (sql === undefined
      ? undefined
      : async (cleanupId: string, userId: string | null) => {
          if (userId === null) return null
          const resolution = await hostStandingOf(sql, cleanupId, userId)
          return resolution === null ? null : resolution.standing
        })
  const mediaUrlPrefixes = platformMediaUrlPrefixes(container)

  return makePageService({
    repo,
    presignCover,
    ...(standingOf !== undefined ? { standingOf } : {}),
    ...(mediaUrlPrefixes.length > 0 ? { mediaUrlPrefixes } : {}),
    counters,
    ...(sql !== undefined ? { audit: auditWriter(sql, logger) } : {}),
    ...(overrides?.now !== undefined ? { now: overrides.now } : {}),
    ...(logger !== undefined ? { logger } : {}),
  })
}

export interface HostGuards {
  requireCapability(
    cleanupId: string,
    userId: string,
    capability: HostCapability,
  ): Promise<HostStanding>
  canManage(cleanupId: string, userId: string | null, capability: HostCapability): Promise<boolean>
  requireVisible(cleanupId: string, userId: string | null): Promise<void>
}

export function makeHostGuards(
  container: Container,
  overrides?: { guards?: HostGuards; repo?: HostRegistrationRepository },
): HostGuards {
  if (overrides?.guards !== undefined) return overrides.guards
  if (overrides?.repo !== undefined) return OPEN_HOST_GUARDS
  const sql = container.getDb().sql
  return {
    async requireCapability(cleanupId, userId, capability): Promise<HostStanding> {
      return (await requireCapability(sql, cleanupId, userId, capability)).standing
    },
    async canManage(cleanupId, userId, capability): Promise<boolean> {
      if (userId === null) return false
      const resolution = await hostStandingOf(sql, cleanupId, userId)
      if (resolution === null) return false
      return can(resolution.standing, capability)
    },
    async requireVisible(cleanupId, userId): Promise<void> {
      await resolveVisibleStanding(sql, cleanupId, userId)
    },
  }
}

export const ORGANIZER_STANDING: HostStanding = { eventRole: "organizer", orgRole: null }

export const OPEN_HOST_GUARDS: HostGuards = {
  async requireCapability(): Promise<HostStanding> {
    return ORGANIZER_STANDING
  },
  async canManage(): Promise<boolean> {
    return true
  },
  async requireVisible(): Promise<void> {},
}
