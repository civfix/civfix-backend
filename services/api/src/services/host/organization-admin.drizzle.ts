import type { Queryable, Sql, SqlFragment } from "../../db/client.js"
import {
  isUuid,
  keysetInstant,
  keysetPredicate,
  paginateKeyset,
  parseKeysetCursor,
} from "../../db/cursor-helpers.js"
import { likeContains } from "../../db/like.js"
import { writeHostAudit } from "./host-audit.js"
import {
  adminActorOf,
  organizationColumns,
  toOrganizationBaseRecord,
  type OrganizationRowSelect,
} from "./organization-rows.drizzle.js"
import type {
  AdminOrganizationCounts,
  AdminOrganizationListQuery,
  AdminOrganizationRecord,
  OrganizationRepository,
  SetOrganizationSuspendedArgs,
  SetOrganizationSuspendedOutcome,
} from "./organization-repository.types.js"

interface AdminOrganizationRowSelect extends OrganizationRowSelect {
  owner_id: string | null
  owner_name: string | null
  owner_handle: string | null
  owner_joined: Date | null
}

interface AdminOrganizationCountsRow {
  all: number
  verified: number
  pending: number
  suspended: number
}

function toAdminOrganizationRecord(row: AdminOrganizationRowSelect): AdminOrganizationRecord {
  return {
    ...toOrganizationBaseRecord(row),
    owner: adminActorOf(row.owner_id, row.owner_name, row.owner_handle, row.owner_joined),
  }
}

/** Owner columns; assumes the admin joins (own/ou) below are in the FROM. */
function adminOrganizationColumns(sql: Queryable) {
  return sql`
    ${organizationColumns(sql, null)},
    ou.id AS owner_id,
    ou.display_name AS owner_name,
    ou.handle AS owner_handle,
    ou.created_at AS owner_joined
  `
}

function adminOrganizationJoins(sql: Queryable) {
  return sql`
    LEFT JOIN media_assets am ON am.id = o.logo_media_id
    LEFT JOIN organization_members own ON own.organization_id = o.id AND own.role = 'owner'
    LEFT JOIN users ou ON ou.id = own.user_id
  `
}

function adminOrganizationFilters(sql: Sql, query: AdminOrganizationListQuery) {
  const q = query.q?.trim() ?? ""
  const search =
    q.length > 0
      ? sql`AND (o.name ILIKE ${likeContains(q)} ESCAPE '\\'
                 OR o.slug ILIKE ${likeContains(q)} ESCAPE '\\'
                 ${isUuid(q) ? sql`OR o.id = ${q}::uuid` : sql``})`
      : sql``
  const verified =
    query.verified !== undefined ? sql`AND o.verified_status = ${query.verified}` : sql``
  const kind = query.kind !== undefined ? sql`AND o.verified_kind = ${query.kind}` : sql``
  const suspended =
    query.suspended === undefined
      ? sql``
      : query.suspended
        ? sql`AND o.suspended_at IS NOT NULL`
        : sql`AND o.suspended_at IS NULL`
  return { search, verified, kind, suspended }
}

export function makeOrganizationAdminMethods(
  sql: Sql,
): Pick<
  OrganizationRepository,
  "adminFindOrganization" | "adminListOrganizations" | "setSuspendedTx"
> {
  /**
   * Facet counts span the SEARCHED set but ignore the facets, and only on page one (the shared
   * admin-list policy: the console reads the chip numbers off the first page).
   */
  async function facetCounts(search: SqlFragment): Promise<AdminOrganizationCounts> {
    const totals = await sql<AdminOrganizationCountsRow[]>`
      SELECT
        count(*)::int AS all,
        count(*) FILTER (WHERE o.verified_status = 'verified')::int AS verified,
        count(*) FILTER (WHERE o.verified_status = 'pending')::int AS pending,
        count(*) FILTER (WHERE o.suspended_at IS NOT NULL)::int AS suspended
      FROM organizations o
      WHERE o.deleted_at IS NULL
        ${search}
    `
    const t = totals[0]
    return {
      all: Number(t?.all ?? 0),
      verified: Number(t?.verified ?? 0),
      pending: Number(t?.pending ?? 0),
      suspended: Number(t?.suspended ?? 0),
    }
  }

  return {
    async adminFindOrganization(id: string): Promise<AdminOrganizationRecord | null> {
      const rows = await sql<AdminOrganizationRowSelect[]>`
        SELECT ${adminOrganizationColumns(sql)}
        FROM organizations o
        ${adminOrganizationJoins(sql)}
        WHERE o.id = ${id} AND o.deleted_at IS NULL
        LIMIT 1
      `
      return rows[0] ? toAdminOrganizationRecord(rows[0]) : null
    },

    async adminListOrganizations(query: AdminOrganizationListQuery): Promise<{
      items: AdminOrganizationRecord[]
      nextCursor: string | null
      counts: AdminOrganizationCounts | null
    }> {
      const cursor = parseKeysetCursor(query.cursor)
      const filters = adminOrganizationFilters(sql, query)
      const cursorFilter =
        cursor !== null
          ? sql`AND ${keysetPredicate(sql, sql`o.created_at`, sql`o.id`, cursor)}`
          : sql``
      const rows = await sql<(AdminOrganizationRowSelect & { cursor_at: string })[]>`
        SELECT ${adminOrganizationColumns(sql)},
               ${keysetInstant(sql, sql`o.created_at`)} AS cursor_at
        FROM organizations o
        ${adminOrganizationJoins(sql)}
        WHERE o.deleted_at IS NULL
          ${filters.search}
          ${filters.verified}
          ${filters.kind}
          ${filters.suspended}
          ${cursorFilter}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT ${query.limit + 1}
      `
      const keyed = paginateKeyset(rows, query.limit, (last) => ({
        atText: last.cursor_at,
        id: last.id,
      }))
      return {
        items: keyed.items.map(toAdminOrganizationRecord),
        nextCursor: keyed.nextCursor,
        counts: cursor === null ? await facetCounts(filters.search) : null,
      }
    },

    async setSuspendedTx(
      args: SetOrganizationSuspendedArgs,
    ): Promise<SetOrganizationSuspendedOutcome> {
      return sql.begin(async (tx) => {
        const updated = await tx<{ id: string }[]>`
          UPDATE organizations
          SET suspended_at = ${args.suspended ? args.now : null},
              suspended_reason = ${args.suspended ? args.reason : null},
              suspended_by = ${args.suspended ? args.actorId : null},
              updated_at = ${args.now}
          WHERE id = ${args.organizationId} AND deleted_at IS NULL
          RETURNING id
        `
        if (updated.length === 0) return "not_found"
        await writeHostAudit(tx, {
          actorId: args.actorId,
          action: args.suspended ? "org.suspended" : "org.unsuspended",
          target: `organization:${args.organizationId}`,
          meta: { reason: args.reason },
        })
        return "updated"
      })
    },
  }
}
