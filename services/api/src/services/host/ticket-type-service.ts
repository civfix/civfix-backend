import { AppError, MAX_TICKET_TYPES_PER_EVENT } from "@civfix/shared"
import type {
  CreateEventTicketTypeRequest,
  DeleteEventTicketTypeRequest,
  ListEventTicketTypesRequest,
  ListEventTicketTypesResponse,
  ReorderEventTicketTypesRequest,
  ReorderEventTicketTypesResponse,
  TicketTypeDTO,
  UpdateEventTicketTypeRequest,
} from "@civfix/shared"
import { sha256Hex } from "../../auth/crypto.js"
import { assertNoSlur } from "../../abuse/slur-filter.js"
import type { Jobs } from "@civfix/shared/interfaces"
import type { CounterStore } from "../../abuse/counter-store.js"
import { toTicketTypeDTO } from "./registration-dto.js"
import type { InsightsInvalidator } from "./host-analytics-cache.js"
import type { HostRegistrationRepository } from "./registration-repository.types.js"
import { enqueueWaitlistPromotion } from "./waitlist-promotion.js"

export const HOST_TICKET_TYPE_COUNTER_KEY = "host:ticketTypes"

export const HOST_TICKET_TYPE_MAX_PER_HOUR = 60

export const HOST_TICKET_TYPE_WINDOW_SECONDS = 60 * 60

export interface TicketTypeServiceDeps {
  repo: HostRegistrationRepository
  jobs?: Jobs
  counters?: CounterStore
  insightsInvalidator?: InsightsInvalidator
  now?: () => Date
  logger?: { warn(obj: unknown, msg?: string): void }
}

export interface TicketTypeService {
  list(
    query: ListEventTicketTypesRequest,
    viewer: { userId: string | null; canManage: boolean },
  ): Promise<ListEventTicketTypesResponse>
  create(input: CreateEventTicketTypeRequest, actorId: string): Promise<TicketTypeDTO>
  update(input: UpdateEventTicketTypeRequest, actorId: string): Promise<TicketTypeDTO>
  remove(input: DeleteEventTicketTypeRequest): Promise<{ ok: true }>
  reorder(input: ReorderEventTicketTypesRequest): Promise<ReorderEventTicketTypesResponse>
}

function capacityExceededError(eventCapacity: number, used: number): AppError {
  return AppError.validation({
    capacity:
      `the ticket types on this event may hold at most ${eventCapacity} seats in total ` +
      `(${used} already allocated) — raise the event capacity first`,
  })
}

function capacityRaised(before: number | null, after: number | null): boolean {
  if (before === null) return false
  return after === null || after > before
}

function salesWindowError(): AppError {
  return AppError.validation({ salesClosesAt: "must be after salesOpensAt" })
}

function nameTakenError(): AppError {
  return AppError.validation({ name: "another ticket type on this event already uses that name" })
}

export function makeTicketTypeService(deps: TicketTypeServiceDeps): TicketTypeService {
  const now = deps.now ?? (() => new Date())

  async function reserveWriteBudget(actorId: string): Promise<void> {
    if (deps.counters === undefined) return
    let used: number
    try {
      used = await deps.counters.incr(
        `${HOST_TICKET_TYPE_COUNTER_KEY}:${actorId}`,
        HOST_TICKET_TYPE_WINDOW_SECONDS,
      )
    } catch (err) {
      deps.logger?.warn(
        { err },
        "ticket types: abuse counter unavailable; refusing the write (fail closed)",
      )
      throw AppError.rateLimited("Ticket type changes are temporarily unavailable.")
    }
    if (used > HOST_TICKET_TYPE_MAX_PER_HOUR) {
      throw AppError.rateLimited("Too many ticket type changes. Try again later.")
    }
  }

  async function eventChanged(cleanupId: string): Promise<void> {
    await deps.insightsInvalidator?.bumpInsightsGeneration(cleanupId)
  }

  return {
    async list(query, viewer): Promise<ListEventTicketTypesResponse> {
      const at = now()
      const records = await deps.repo.listTicketTypes(query.id)
      const unlocked =
        query.accessCode === undefined
          ? new Set<string>()
          : new Set(
              await deps.repo.ticketTypeIdsMatchingAccessCode(
                query.id,
                await sha256Hex(query.accessCode.trim()),
              ),
            )
      const items = records
        .filter((record) => {
          if (viewer.canManage) return true
          if (record.visibility === "public") return true
          if (record.visibility === "hidden") return false
          return unlocked.has(record.id)
        })
        .map((record) => toTicketTypeDTO(record, at))
      return { items }
    },

    async create(input, actorId): Promise<TicketTypeDTO> {
      assertNoSlur(input.name, "name")
      if (input.description != null) assertNoSlur(input.description, "description")
      await reserveWriteBudget(actorId)

      if (input.visibility === "access_code" && (input.accessCode ?? null) === null) {
        throw AppError.validation({ accessCode: "required for an access-code ticket type" })
      }

      const outcome = await deps.repo.createTicketType({
        cleanupId: input.id,
        name: input.name,
        description: input.description ?? null,
        capacity: input.capacity ?? null,
        salesOpensAt:
          input.salesOpensAt === undefined || input.salesOpensAt === null
            ? null
            : new Date(input.salesOpensAt),
        salesClosesAt:
          input.salesClosesAt === undefined || input.salesClosesAt === null
            ? null
            : new Date(input.salesClosesAt),
        visibility: input.visibility,
        accessCodeHash: input.accessCode == null ? null : await sha256Hex(input.accessCode.trim()),
        clearAccessCode: false,
        maxPartySize: input.maxPartySize,
        sortOrder: input.sortOrder ?? null,
        waitlistEnabled: input.waitlistEnabled,
        questionIds: input.questionIds ?? null,
        now: now(),
      })

      switch (outcome.kind) {
        case "created":
          await eventChanged(input.id)
          return toTicketTypeDTO(outcome.record, now())
        case "name_taken":
          throw nameTakenError()
        case "too_many":
          throw AppError.conflict(
            `An event can have at most ${MAX_TICKET_TYPES_PER_EVENT} ticket types.`,
          )
        case "capacity_exceeded":
          throw capacityExceededError(outcome.eventCapacity, outcome.used)
        case "sales_window":
          throw salesWindowError()
        case "not_found":
          throw AppError.notFound("Cleanup not found")
      }
    },

    async update(input, actorId): Promise<TicketTypeDTO> {
      if (input.name !== undefined) assertNoSlur(input.name, "name")
      if (input.description != null) assertNoSlur(input.description, "description")
      await reserveWriteBudget(actorId)

      const patch = Object.keys(input).filter((key) => key !== "id" && key !== "ticketTypeId")
      const current = await deps.repo.getTicketType(input.id, input.ticketTypeId)
      if (current === null) throw AppError.notFound("Ticket type not found")

      const nextVisibility = input.visibility ?? current.visibility
      const clearAccessCode = input.accessCode === null
      const settingCode = input.accessCode != null
      if (nextVisibility === "access_code" && !current.accessCodeSet && !settingCode) {
        throw AppError.validation({ accessCode: "required for an access-code ticket type" })
      }
      if (nextVisibility === "access_code" && clearAccessCode) {
        throw AppError.validation({ accessCode: "required for an access-code ticket type" })
      }

      const outcome = await deps.repo.updateTicketType({
        cleanupId: input.id,
        ticketTypeId: input.ticketTypeId,
        patch,
        name: input.name ?? current.name,
        description: input.description ?? null,
        capacity: input.capacity ?? null,
        salesOpensAt: input.salesOpensAt == null ? null : new Date(input.salesOpensAt),
        salesClosesAt: input.salesClosesAt == null ? null : new Date(input.salesClosesAt),
        visibility: nextVisibility,
        accessCodeHash: settingCode ? await sha256Hex((input.accessCode as string).trim()) : null,
        clearAccessCode,
        maxPartySize: input.maxPartySize ?? current.maxPartySize,
        sortOrder: input.sortOrder ?? null,
        waitlistEnabled: input.waitlistEnabled ?? current.waitlistEnabled,
        questionIds: input.questionIds ?? null,
        now: now(),
      })

      switch (outcome.kind) {
        case "updated":
          if (capacityRaised(current.capacity, outcome.record.capacity)) {
            await enqueueWaitlistPromotion(deps.jobs, [input.ticketTypeId], deps.logger)
          }
          await eventChanged(input.id)
          return toTicketTypeDTO(outcome.record, now())
        case "name_taken":
          throw nameTakenError()
        case "capacity_below_reserved":
          throw AppError.validation({
            capacity: `already holding ${outcome.reservedSeats} seats — cancel registrations before lowering it`,
          })
        case "capacity_exceeded":
          throw capacityExceededError(outcome.eventCapacity, outcome.used)
        case "sales_window":
          throw salesWindowError()
        case "not_found":
          throw AppError.notFound("Ticket type not found")
      }
    },

    async remove(input): Promise<{ ok: true }> {
      const outcome = await deps.repo.deleteTicketType(input.id, input.ticketTypeId)
      if (outcome.kind === "not_found") throw AppError.notFound("Ticket type not found")
      if (outcome.kind === "in_use") {
        throw AppError.conflict(
          "This ticket type has registrations. Close sales instead of deleting it.",
        )
      }
      await eventChanged(input.id)
      return { ok: true }
    },

    async reorder(input): Promise<ReorderEventTicketTypesResponse> {
      const outcome = await deps.repo.reorderTicketTypes(input.id, input.ticketTypeIds, now())
      if (outcome.kind === "mismatch") {
        throw AppError.validation({
          ticketTypeIds: "must list every ticket type on this event exactly once",
        })
      }
      await eventChanged(input.id)
      const at = now()
      return { items: outcome.items.map((record) => toTicketTypeDTO(record, at)) }
    },
  }
}
