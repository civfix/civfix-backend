import type { Queryable, Sql, TransactionSql } from "../../db/client.js"
import { constantTimeStringEqual } from "../../auth/crypto.js"
import { isCheckViolationOn, isUniqueViolationOn } from "../../db/pg-errors.js"
import { SALES_WINDOW_CONSTRAINT } from "./registration-sql.js"
import { loadTicketType, loadTicketTypes } from "./registration-repository-load.drizzle.js"
import type {
  CreateTicketTypeOutcome,
  DeleteTicketTypeOutcome,
  HostRegistrationRepository,
  ReorderTicketTypesOutcome,
  TicketTypeCapacityFit,
  TicketTypeRecord,
  TicketTypeWriteArgs,
  UpdateTicketTypeOutcome,
} from "./registration-repository.js"

export const MAX_TICKET_TYPES = 20

const TICKET_TYPE_NAME_CONSTRAINT = "cleanup_ticket_types_cleanup_name_uidx"

export type TicketTypeMethods = Pick<
  HostRegistrationRepository,
  | "listTicketTypes"
  | "listTicketTypesFor"
  | "getTicketType"
  | "ticketTypeIdsMatchingAccessCode"
  | "createTicketType"
  | "updateTicketType"
  | "deleteTicketType"
  | "reorderTicketTypes"
>

async function applyQuestionOwnership(
  tag: Queryable,
  cleanupId: string,
  ticketTypeId: string,
  questionIds: readonly string[],
): Promise<void> {
  await tag`
    UPDATE cleanup_questions
       SET ticket_type_id = NULL, updated_at = now()
     WHERE cleanup_id = ${cleanupId}
       AND ticket_type_id = ${ticketTypeId}
       AND NOT (id = ANY(${[...questionIds]}::uuid[]))
  `
  if (questionIds.length === 0) return
  await tag`
    UPDATE cleanup_questions
       SET ticket_type_id = ${ticketTypeId}, updated_at = now()
     WHERE cleanup_id = ${cleanupId}
       AND id = ANY(${[...questionIds]}::uuid[])
  `
}

async function ticketTypeCapacityFit(
  tx: TransactionSql,
  cleanupId: string,
  eventCapacity: number | null,
  nextCapacity: number | null,
  excludeTicketTypeId: string | null,
): Promise<TicketTypeCapacityFit> {
  if (eventCapacity === null) return { ok: true }
  const exclude = excludeTicketTypeId === null ? tx`` : tx`AND id <> ${excludeTicketTypeId}`
  const rows = await tx<{ used: number | null; unlimited: boolean | null }[]>`
    SELECT sum(capacity)::int AS used, bool_or(capacity IS NULL) AS unlimited
      FROM cleanup_ticket_types
     WHERE cleanup_id = ${cleanupId}
       ${exclude}
  `
  const used = rows[0]?.used ?? 0
  if (rows[0]?.unlimited === true) return { ok: false, eventCapacity, used }
  if (nextCapacity === null) return { ok: false, eventCapacity, used }
  if (used + nextCapacity > eventCapacity) return { ok: false, eventCapacity, used }
  return { ok: true }
}

function ticketTypeWriteRefusal(err: unknown): { kind: "name_taken" | "sales_window" } | null {
  if (isUniqueViolationOn(err, TICKET_TYPE_NAME_CONSTRAINT)) return { kind: "name_taken" }
  if (isCheckViolationOn(err, SALES_WINDOW_CONSTRAINT)) return { kind: "sales_window" }
  return null
}

async function insertTicketTypeIn(
  tx: TransactionSql,
  args: TicketTypeWriteArgs,
): Promise<CreateTicketTypeOutcome> {
  const locked = await tx<{ id: string; capacity: number | null }[]>`
    SELECT id, capacity FROM cleanups
     WHERE id = ${args.cleanupId}
     LIMIT 1 FOR NO KEY UPDATE
  `
  const event = locked[0]
  if (event === undefined) return { kind: "not_found" }

  const counted = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM cleanup_ticket_types WHERE cleanup_id = ${args.cleanupId}
  `
  if ((counted[0]?.n ?? 0) >= MAX_TICKET_TYPES) return { kind: "too_many" }

  const fit = await ticketTypeCapacityFit(tx, args.cleanupId, event.capacity, args.capacity, null)
  if (!fit.ok) {
    return { kind: "capacity_exceeded", eventCapacity: fit.eventCapacity, used: fit.used }
  }

  const sortOrder =
    args.sortOrder ??
    (
      await tx<{ next: number }[]>`
        SELECT COALESCE(max(sort_order), -1) + 1 AS next
          FROM cleanup_ticket_types WHERE cleanup_id = ${args.cleanupId}
      `
    )[0]?.next ??
    0

  const inserted = await tx<{ id: string }[]>`
    INSERT INTO cleanup_ticket_types (
      cleanup_id, name, description, capacity, sales_opens_at, sales_closes_at,
      visibility, access_code_hash, max_party_size, sort_order, waitlist_enabled,
      created_at, updated_at
    ) VALUES (
      ${args.cleanupId}, ${args.name}, ${args.description}, ${args.capacity},
      ${args.salesOpensAt}, ${args.salesClosesAt}, ${args.visibility},
      ${args.accessCodeHash}, ${args.maxPartySize}, ${sortOrder}, ${args.waitlistEnabled},
      ${args.now}, ${args.now}
    )
    RETURNING id
  `
  const id = inserted[0]?.id
  if (id === undefined) throw new Error("ticket type insert returned no row")

  if (args.questionIds !== null) {
    await applyQuestionOwnership(tx, args.cleanupId, id, args.questionIds)
  }

  const record = await loadTicketType(tx, args.cleanupId, id)
  if (record === null) throw new Error("ticket type reload returned no row")
  return { kind: "created", record }
}

async function updateTicketTypeIn(
  sql: Sql,
  tx: TransactionSql,
  args: TicketTypeWriteArgs & { ticketTypeId: string; patch: readonly string[] },
): Promise<UpdateTicketTypeOutcome> {
  const patch = new Set(args.patch)
  const event = (
    await tx<{ id: string; capacity: number | null }[]>`
      SELECT id, capacity FROM cleanups
       WHERE id = ${args.cleanupId}
       LIMIT 1 FOR NO KEY UPDATE
    `
  )[0]
  if (event === undefined) return { kind: "not_found" }

  const locked = await tx<{ reserved_seats: number }[]>`
    SELECT reserved_seats FROM cleanup_ticket_types
     WHERE id = ${args.ticketTypeId} AND cleanup_id = ${args.cleanupId}
     LIMIT 1 FOR UPDATE
  `
  const current = locked[0]
  if (current === undefined) return { kind: "not_found" }

  if (patch.has("capacity") && args.capacity !== null && args.capacity < current.reserved_seats) {
    return { kind: "capacity_below_reserved", reservedSeats: current.reserved_seats }
  }

  if (patch.has("capacity")) {
    const fit = await ticketTypeCapacityFit(
      tx,
      args.cleanupId,
      event.capacity,
      args.capacity,
      args.ticketTypeId,
    )
    if (!fit.ok) {
      return { kind: "capacity_exceeded", eventCapacity: fit.eventCapacity, used: fit.used }
    }
  }

  await tx`
    UPDATE cleanup_ticket_types SET
      name             = ${patch.has("name") ? args.name : sql`name`},
      description      = ${patch.has("description") ? args.description : sql`description`},
      capacity         = ${patch.has("capacity") ? args.capacity : sql`capacity`},
      sales_opens_at   = ${patch.has("salesOpensAt") ? args.salesOpensAt : sql`sales_opens_at`},
      sales_closes_at  = ${patch.has("salesClosesAt") ? args.salesClosesAt : sql`sales_closes_at`},
      visibility       = ${patch.has("visibility") ? args.visibility : sql`visibility`},
      access_code_hash = ${
        args.clearAccessCode
          ? null
          : args.accessCodeHash !== null
            ? args.accessCodeHash
            : sql`access_code_hash`
      },
      max_party_size   = ${patch.has("maxPartySize") ? args.maxPartySize : sql`max_party_size`},
      sort_order       = ${patch.has("sortOrder") && args.sortOrder !== null ? args.sortOrder : sql`sort_order`},
      waitlist_enabled = ${patch.has("waitlistEnabled") ? args.waitlistEnabled : sql`waitlist_enabled`},
      updated_at       = ${args.now}
    WHERE id = ${args.ticketTypeId} AND cleanup_id = ${args.cleanupId}
  `

  if (args.questionIds !== null) {
    await applyQuestionOwnership(tx, args.cleanupId, args.ticketTypeId, args.questionIds)
  }

  const record = await loadTicketType(tx, args.cleanupId, args.ticketTypeId)
  if (record === null) return { kind: "not_found" }
  return { kind: "updated", record }
}

export function makeTicketTypeMethods(sql: Sql): TicketTypeMethods {
  return {
    async listTicketTypes(cleanupId: string): Promise<TicketTypeRecord[]> {
      return loadTicketTypes(sql, [cleanupId])
    },

    async listTicketTypesFor(
      cleanupIds: readonly string[],
    ): Promise<Map<string, TicketTypeRecord[]>> {
      const out = new Map<string, TicketTypeRecord[]>()
      for (const record of await loadTicketTypes(sql, cleanupIds)) {
        const bucket = out.get(record.cleanupId)
        if (bucket === undefined) out.set(record.cleanupId, [record])
        else bucket.push(record)
      }
      return out
    },

    async getTicketType(cleanupId: string, ticketTypeId: string): Promise<TicketTypeRecord | null> {
      return loadTicketType(sql, cleanupId, ticketTypeId)
    },

    async ticketTypeIdsMatchingAccessCode(
      cleanupId: string,
      accessCodeHash: string,
    ): Promise<string[]> {
      const rows = await sql<{ id: string; access_code_hash: string | null }[]>`
        SELECT id, access_code_hash FROM cleanup_ticket_types
         WHERE cleanup_id = ${cleanupId} AND visibility = 'access_code'
         ORDER BY sort_order, id
         LIMIT ${MAX_TICKET_TYPES}
      `
      return rows
        .filter(
          (row) =>
            row.access_code_hash !== null &&
            constantTimeStringEqual(accessCodeHash, row.access_code_hash),
        )
        .map((row) => row.id)
    },

    async createTicketType(args: TicketTypeWriteArgs): Promise<CreateTicketTypeOutcome> {
      try {
        return await sql.begin((tx) => insertTicketTypeIn(tx, args))
      } catch (err) {
        const refusal = ticketTypeWriteRefusal(err)
        if (refusal !== null) return refusal
        throw err
      }
    },

    async updateTicketType(
      args: TicketTypeWriteArgs & { ticketTypeId: string; patch: readonly string[] },
    ): Promise<UpdateTicketTypeOutcome> {
      try {
        return await sql.begin((tx) => updateTicketTypeIn(sql, tx, args))
      } catch (err) {
        const refusal = ticketTypeWriteRefusal(err)
        if (refusal !== null) return refusal
        throw err
      }
    },

    async deleteTicketType(
      cleanupId: string,
      ticketTypeId: string,
    ): Promise<DeleteTicketTypeOutcome> {
      return sql.begin(async (tx) => {
        const locked = await tx<{ id: string }[]>`
          SELECT id FROM cleanup_ticket_types
           WHERE id = ${ticketTypeId} AND cleanup_id = ${cleanupId}
           LIMIT 1 FOR UPDATE
        `
        if (locked[0] === undefined) return { kind: "not_found" as const }

        const referenced = await tx<{ one: number }[]>`
          SELECT 1 AS one WHERE EXISTS (
            SELECT 1 FROM cleanup_registrations
             WHERE cleanup_id = ${cleanupId} AND ticket_type_id = ${ticketTypeId}
          ) OR EXISTS (
            SELECT 1 FROM cleanup_waitlist
             WHERE cleanup_id = ${cleanupId} AND ticket_type_id = ${ticketTypeId}
          )
        `
        if (referenced.length > 0) return { kind: "in_use" as const }

        await tx`
          UPDATE cleanup_questions SET ticket_type_id = NULL, updated_at = now()
           WHERE cleanup_id = ${cleanupId} AND ticket_type_id = ${ticketTypeId}
        `
        await tx`
          DELETE FROM cleanup_ticket_types
           WHERE id = ${ticketTypeId} AND cleanup_id = ${cleanupId}
        `
        return { kind: "deleted" as const }
      })
    },

    async reorderTicketTypes(
      cleanupId: string,
      ticketTypeIds: readonly string[],
      now: Date,
    ): Promise<ReorderTicketTypesOutcome> {
      return sql.begin(async (tx) => {
        const existing = await tx<{ id: string }[]>`
          SELECT id FROM cleanup_ticket_types WHERE cleanup_id = ${cleanupId} ORDER BY id
        `
        const have = new Set(existing.map((r) => r.id))
        const want = new Set(ticketTypeIds)
        if (have.size !== want.size || [...want].some((id) => !have.has(id))) {
          return { kind: "mismatch" as const }
        }
        // The contract admits a repeated id and its last position wins; UPDATE ... FROM applies an
        // arbitrary one of several source rows for a target, so each id goes in exactly once.
        const position = new Map<string, number>()
        ticketTypeIds.forEach((id, index) => position.set(id, index))
        await tx`
          UPDATE cleanup_ticket_types t
             SET sort_order = u.sort_order, updated_at = ${now}
            FROM unnest(${[...position.keys()]}::uuid[], ${[...position.values()]}::int[])
                 AS u(id, sort_order)
           WHERE t.id = u.id AND t.cleanup_id = ${cleanupId}
        `
        return { kind: "reordered" as const, items: await loadTicketTypes(tx, [cleanupId]) }
      })
    },
  }
}
