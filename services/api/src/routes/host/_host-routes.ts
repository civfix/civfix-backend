import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import { IdSchema } from "@civfix/shared"
import type { Container } from "../../di.js"
import { perHost, perIdentity } from "../../plugins/rate-limit.js"
import {
  makeContainerPageService,
  makeContainerRegistrationServices,
  makeHostGuards,
  type HostGuards,
  type HostPageOverrides,
  type HostRegistrationOverrides,
  type HostRegistrationServices,
} from "../../services/host/registration-wiring.js"
import type { PageService } from "../../services/host/page-service.js"

const ONE_MINUTE = "1 minute"

/** A cheap bound on the raw param; the request schema validates the slug itself. */
const PAGE_SLUG_PARAM_MAX = 120

export const CleanupIdParamsSchema = z.object({ id: IdSchema }).strict()

export const TicketTypeParamsSchema = z.object({ id: IdSchema, ticketTypeId: IdSchema }).strict()

export const RegistrationParamsSchema = z
  .object({ id: IdSchema, registrationId: IdSchema })
  .strict()

export const WaitlistParamsSchema = z.object({ id: IdSchema, waitlistId: IdSchema }).strict()

export const SeatParamsSchema = z.object({ id: IdSchema, seatId: IdSchema }).strict()

export const PageSlugParamsSchema = z
  .object({ slug: z.string().min(1).max(PAGE_SLUG_PARAM_MAX) })
  .strict()

export const TICKET_TYPE_READ_RATE_LIMIT = perHost({ max: 120, timeWindow: ONE_MINUTE })
export const TICKET_TYPE_WRITE_RATE_LIMIT = perIdentity({ max: 30, timeWindow: ONE_MINUTE })
export const QUESTION_WRITE_RATE_LIMIT = perIdentity({ max: 30, timeWindow: ONE_MINUTE })
export const REGISTER_RATE_LIMIT = perIdentity({ max: 10, timeWindow: ONE_MINUTE })
export const ROSTER_READ_RATE_LIMIT = perIdentity({ max: 60, timeWindow: ONE_MINUTE })
export const WALKUP_RATE_LIMIT = perIdentity({ max: 60, timeWindow: ONE_MINUTE })
export const REGISTRATION_WRITE_RATE_LIMIT = perIdentity({ max: 30, timeWindow: ONE_MINUTE })
export const WAITLIST_WRITE_RATE_LIMIT = perIdentity({ max: 20, timeWindow: ONE_MINUTE })
export const WAITLIST_READ_RATE_LIMIT = perIdentity({ max: 60, timeWindow: ONE_MINUTE })
export const PAGE_READ_RATE_LIMIT = perIdentity({ max: 60, timeWindow: ONE_MINUTE })
export const PAGE_WRITE_RATE_LIMIT = perIdentity({ max: 30, timeWindow: ONE_MINUTE })
export const PUBLIC_PAGE_RATE_LIMIT = perHost({ max: 120, timeWindow: ONE_MINUTE })
export const SCAN_RATE_LIMIT = perIdentity({ max: 300, timeWindow: ONE_MINUTE })
export const CHECKIN_RATE_LIMIT = perIdentity({ max: 120, timeWindow: ONE_MINUTE })
export const TICKET_READ_RATE_LIMIT = perIdentity({ max: 60, timeWindow: ONE_MINUTE })
export const GUEST_TICKET_RATE_LIMIT = perHost({ max: 20, timeWindow: ONE_MINUTE })

declare module "fastify" {
  interface FastifyInstance {
    hostRegistrationOverrides?: HostRegistrationOverrides
    hostPageOverrides?: HostPageOverrides
  }
}

export interface HostRouteContext {
  services(): HostRegistrationServices
  guards(): HostGuards
  pages(): PageService
  pageGuards(): HostGuards
}

export function makeHostRouteContext(app: FastifyInstance, container: Container): HostRouteContext {
  let services: HostRegistrationServices | undefined
  let guards: HostGuards | undefined
  let pages: PageService | undefined
  let pageGuards: HostGuards | undefined

  return {
    services(): HostRegistrationServices {
      return (services ??= makeContainerRegistrationServices(
        container,
        app.hostRegistrationOverrides,
        app.log,
      ))
    },
    guards(): HostGuards {
      return (guards ??= makeHostGuards(container, app.hostRegistrationOverrides))
    },
    pages(): PageService {
      return (pages ??= makeContainerPageService(container, app.hostPageOverrides, app.log))
    },
    pageGuards(): HostGuards {
      return (pageGuards ??= makeHostGuards(container, app.hostPageOverrides))
    },
  }
}

export function bodyWith(request: FastifyRequest, extra: Record<string, unknown>): object {
  return { ...((request.body ?? {}) as object), ...extra }
}

export function queryWith(request: FastifyRequest, extra: Record<string, unknown>): object {
  return { ...((request.query ?? {}) as object), ...extra }
}
