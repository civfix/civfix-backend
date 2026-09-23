import type { Sql } from "../../db/client.js"
import { decodeOffsetCursor, encodeOffsetCursor, clampLimit } from "./pagination.js"
import { writeAudit } from "./audit.js"
import {
  invalidateDirectoryFacetCache,
  readDirectoryFacetCache,
  upsertJurisdictionContacts,
  writeDirectoryFacetCache,
} from "./discovery-repository.drizzle.js"
import { buildUnmappedRecord, shouldIncludeUnmapped } from "./jurisdiction-directory-projection.js"
import {
  ADMIN_CATEGORIES,
  categoryCountsFragment,
  categoryCountsProjection,
  parseCategoryCounts,
  parseCount,
  type CategoryCountRow,
} from "./category-counts.js"
import type {
  JurisdictionContactsRepository,
  JurisdictionDirectoryRecord,
  JurisdictionGeometryRecord,
  ListDirectoryArgs,
  ListDirectoryResult,
  PatchContactsInput,
  SaveContactsInput,
} from "./jurisdiction-contacts-types.js"
import { AppError } from "@civfix/shared"
import type { JurisdictionLayer, ReportCategory } from "@civfix/shared"
import { ilikeAnyOf } from "./sql-fragments.js"

const PG_UNIQUE_VIOLATION = "23505"
const JURISDICTION_HANDLE_CONSTRAINT = "jurisdictions_handle_lower_key"

function isJurisdictionHandleConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  const e = err as { code?: unknown; constraint_name?: unknown }
  return e.code === PG_UNIQUE_VIOLATION && e.constraint_name === JURISDICTION_HANDLE_CONSTRAINT
}

interface DirectoryRow extends CategoryCountRow {
  geoid: string
  name: string
  layer: string
  population: number | null
  default_emails: string[] | null
  report_form_url: string | null
  contact_updated_at: Date | null
  has_default_contact: boolean
  category_emails: { category: string; email: string | null }[] | null
  last_routed_at: Date | null
  bounced: boolean
  flagged_at: Date | null
  handle: string | null
  forward_subject_template: string | null
  forward_body_template: string | null
  filtered_total: string
  reports_waiting: string
  oldest_waiting_at: Date | null
}

function toRecord(r: DirectoryRow): JurisdictionDirectoryRecord {
  const categoryContacts = (r.category_emails ?? [])
    .filter((c): c is { category: ReportCategory; email: string | null } =>
      (ADMIN_CATEGORIES as readonly string[]).includes(c.category),
    )
    .map((c) => ({ category: c.category, email: c.email }))
  const perCategoryCounts = parseCategoryCounts(r)
  return {
    geoid: r.geoid,
    name: r.name,
    layer: r.layer as JurisdictionLayer,
    population: r.population,
    defaultEmails: r.default_emails ?? [],
    categoryContacts,
    hasDefaultContact: r.has_default_contact,
    reportFormUrl: r.report_form_url,
    reportsWaiting: parseCount(r.reports_waiting),
    perCategoryCounts,
    oldestReportAt: r.oldest_waiting_at,
    lastRoutedAt: r.last_routed_at,
    bounced: r.bounced,
    contactUpdatedAt: r.contact_updated_at,
    flaggedAt: r.flagged_at,
    handle: r.handle,
    forwardSubjectTemplate: r.forward_subject_template,
    forwardBodyTemplate: r.forward_body_template,
  }
}

async function loadUnmappedAggregate(
  sql: Sql,
): Promise<{ total: number; perCategoryCounts: Partial<Record<ReportCategory, number>> }> {
  const rows = await sql<(CategoryCountRow & { total: string })[]>`
    SELECT
      COUNT(*)::text AS total,
      ${categoryCountsFragment(sql, "r")}
    FROM reports r
    LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
    WHERE r.deleted_at IS NULL
      AND r.status NOT IN ('rejected', 'resolved', 'acknowledged', 'in_progress')
      AND (r.jurisdiction_geoid IS NULL OR j.geoid IS NULL)
  `
  const r = rows[0]
  return { total: parseCount(r?.total), perCategoryCounts: parseCategoryCounts(r) }
}

export function makeDrizzleJurisdictionContactsRepository(
  sql: Sql,
): JurisdictionContactsRepository {
  return {
    async jurisdictionExists(geoid: string): Promise<boolean> {
      const rows = await sql<{ geoid: string }[]>`
        SELECT geoid FROM jurisdictions WHERE geoid = ${geoid} LIMIT 1
      `
      return rows.length > 0
    },

    async saveAndRoute(
      geoid: string,
      input: SaveContactsInput,
      audit: { actorId: string | null },
    ): Promise<{ taskResolved: boolean }> {
      const committed = await sql.begin(async (tx) => {
        await upsertJurisdictionContacts(
          tx,
          geoid,
          input.contacts,
          input.defaultEmails,
          input.formUrl,
        )
        await tx`
          UPDATE jurisdictions
          SET contact_updated_at = now(),
              forward_subject_template = CASE
                WHEN ${input.forwardSubjectTemplate !== undefined}
                  THEN ${input.forwardSubjectTemplate === "" ? null : (input.forwardSubjectTemplate ?? null)}
                ELSE forward_subject_template
              END,
              forward_body_template = CASE
                WHEN ${input.forwardBodyTemplate !== undefined}
                  THEN ${input.forwardBodyTemplate === "" ? null : (input.forwardBodyTemplate ?? null)}
                ELSE forward_body_template
              END
          WHERE geoid = ${geoid}
        `

        const tasks = await tx<{ id: string }[]>`
          UPDATE jurisdiction_discovery_tasks
          SET status = 'done'
          WHERE geoid = ${geoid} AND status <> 'done'
          RETURNING id
        `
        const taskResolved = tasks.length > 0

        await writeAudit(tx, {
          actorId: audit.actorId,
          action: "discovery.contacts_saved",
          target: `jurisdiction:${geoid}`,
          meta: {
            geoid,
            categories: Object.keys(input.contacts),
            defaultEmails: input.defaultEmails,
            taskResolved,
          },
        })

        return { taskResolved }
      })
      invalidateDirectoryFacetCache()
      return { taskResolved: committed.taskResolved }
    },

    async patch(
      geoid: string,
      input: PatchContactsInput,
      audit: { actorId: string | null },
    ): Promise<boolean> {
      const result = await sql.begin(async (tx) => {
        const exists = await tx<{ geoid: string }[]>`
          SELECT geoid FROM jurisdictions WHERE geoid = ${geoid} LIMIT 1
        `
        if (exists.length === 0) return false

        const touchedContact =
          input.contacts !== undefined ||
          input.defaultEmails !== undefined ||
          input.formUrl !== undefined
        if (touchedContact) {
          await upsertJurisdictionContacts(
            tx,
            geoid,
            input.contacts ?? {},
            input.defaultEmails ?? [],
            input.formUrl ?? null,
          )
          await tx`UPDATE jurisdictions SET contact_updated_at = now() WHERE geoid = ${geoid}`
        }
        if (input.notes !== undefined) {
          await tx`UPDATE jurisdictions SET notes = ${input.notes} WHERE geoid = ${geoid}`
        }
        if (input.flagged !== undefined) {
          if (input.flagged) {
            await tx`UPDATE jurisdictions SET flagged_at = now(), flag_reason = ${input.flagReason ?? null} WHERE geoid = ${geoid}`
          } else {
            await tx`UPDATE jurisdictions SET flagged_at = NULL, flag_reason = NULL WHERE geoid = ${geoid}`
          }
        }
        if (input.handle !== undefined) {
          const handle = input.handle
          if (handle === null || handle === "") {
            await tx`UPDATE jurisdictions SET handle = NULL WHERE geoid = ${geoid}`
          } else {
            const dupeJurisdiction = await tx<{ geoid: string }[]>`
              SELECT geoid FROM jurisdictions
              WHERE handle IS NOT NULL AND lower(handle) = lower(${handle}) AND geoid <> ${geoid}
              LIMIT 1
            `
            if (dupeJurisdiction.length > 0) {
              throw AppError.conflict("That @handle is already used by another jurisdiction.")
            }
            const dupeUser = await tx<{ id: string }[]>`
              SELECT id FROM users WHERE lower(handle::text) = lower(${handle}) LIMIT 1
            `
            if (dupeUser.length > 0) {
              throw AppError.conflict("That @handle is already taken by a member.")
            }
            try {
              await tx`UPDATE jurisdictions SET handle = ${handle} WHERE geoid = ${geoid}`
            } catch (err) {
              if (isJurisdictionHandleConflict(err)) {
                throw AppError.conflict("That @handle is already used by another jurisdiction.")
              }
              throw err
            }
          }
        }
        if (input.forwardSubjectTemplate !== undefined) {
          const t = input.forwardSubjectTemplate
          await tx`UPDATE jurisdictions SET forward_subject_template = ${t === null || t === "" ? null : t} WHERE geoid = ${geoid}`
        }
        if (input.forwardBodyTemplate !== undefined) {
          const t = input.forwardBodyTemplate
          await tx`UPDATE jurisdictions SET forward_body_template = ${t === null || t === "" ? null : t} WHERE geoid = ${geoid}`
        }
        await writeAudit(tx, {
          actorId: audit.actorId,
          action: "jurisdiction.patched",
          target: `jurisdiction:${geoid}`,
          meta: {
            geoid,
            fields: Object.keys(input).filter(
              (k) => (input as Record<string, unknown>)[k] !== undefined,
            ),
          },
        })
        return true
      })
      invalidateDirectoryFacetCache()
      return result
    },

    async getOutreachState(
      geoid: string,
    ): Promise<{ lastOutreachAt: Date | null; suppressed: boolean } | null> {
      const rows = await sql<{ last_outreach_at: Date | null; suppressed: boolean }[]>`
        SELECT last_outreach_at, suppressed FROM outreach_state WHERE geoid = ${geoid} LIMIT 1
      `
      const row = rows[0]
      if (!row) return null
      return { lastOutreachAt: row.last_outreach_at, suppressed: row.suppressed }
    },

    async listDirectory(args: ListDirectoryArgs): Promise<ListDirectoryResult> {
      const search =
        args.q !== null ? sql`AND ${ilikeAnyOf(sql, [sql`j.name`, sql`j.geoid`], args.q)}` : sql``
      const offset = decodeOffsetCursor(args.cursor)
      const limit = clampLimit(args.limit)

      const hasEmailExpr = sql`(
        EXISTS (
          SELECT 1 FROM unnest(COALESCE(j.contact_emails, '{}'::text[])) AS e(v)
          WHERE btrim(e.v) <> ''
        )
        OR EXISTS (
          SELECT 1 FROM jurisdiction_contacts mc
          WHERE mc.geoid = j.geoid AND mc.category IS NOT NULL
            AND mc.email IS NOT NULL AND btrim(mc.email) <> ''
        )
      )`
      const hasFormExpr = sql`(j.report_form_url IS NOT NULL AND btrim(j.report_form_url) <> '')`
      const methodFilter =
        args.filter === "email"
          ? sql`AND ${hasEmailExpr}`
          : args.filter === "form"
            ? sql`AND NOT ${hasEmailExpr} AND ${hasFormExpr}`
            : args.filter === "none"
              ? sql`AND NOT (${hasEmailExpr} OR ${hasFormExpr})`
              : args.filter === "routed"
                ? sql`AND (${hasEmailExpr} OR ${hasFormExpr})`
                : args.filter === "needs_mapping"
                  ? sql`AND NOT (${hasEmailExpr} OR ${hasFormExpr}) AND COALESCE(w.total, 0) > 0`
                  : sql``

      const layerFilter = args.layer !== null ? sql`AND j.layer = ${args.layer}` : sql``

      const orderBy =
        args.sort === "reports"
          ? sql`ORDER BY COALESCE(w.total, 0) DESC, j.geoid ASC`
          : args.sort === "name"
            ? sql`ORDER BY j.name ASC, j.geoid ASC`
            : args.sort === "oldest"
              ? sql`ORDER BY w.oldest_waiting_at ASC NULLS LAST, j.geoid ASC`
              : sql`ORDER BY COALESCE(j.population, 0) DESC, j.geoid ASC`

      const rows = await sql<DirectoryRow[]>`
        WITH waiting AS (
          -- "Waiting" = open, un-routed reports: excludes acknowledged/in_progress (already routed) and
          -- rejected/resolved (closed). So reportsWaiting is the backlog needing a contact, and it drops
          -- as operators route those reports one by one.
          --
          -- Aggregated ONCE for every geoid rather than per row. The page's COUNT(*) OVER() has to
          -- materialize the whole filtered set before OFFSET/LIMIT, so as a per-row LATERAL this aggregate
          -- ran for every jurisdiction matching the filter on every page view.
          SELECT
            r.jurisdiction_geoid AS geoid,
            COUNT(*) AS total,
            -- Oldest still-waiting report; shares the waiting predicate so it agrees with total.
            MIN(r.created_at) AS oldest_waiting_at,
            ${categoryCountsFragment(sql, "r")}
          FROM reports r
          WHERE r.jurisdiction_geoid IS NOT NULL
            AND r.deleted_at IS NULL
            AND r.status NOT IN ('rejected', 'resolved', 'acknowledged', 'in_progress')
          GROUP BY r.jurisdiction_geoid
        )
        SELECT
          j.geoid,
          j.name,
          j.contact_emails AS default_emails,
          j.report_form_url,
          j.contact_updated_at,
          EXISTS (
            SELECT 1 FROM jurisdiction_contacts dc
            WHERE dc.geoid = j.geoid AND dc.category IS NULL
              AND dc.email IS NOT NULL AND dc.email <> ''
          ) AS has_default_contact,
          (
            SELECT COALESCE(
              json_agg(json_build_object('category', cc.category, 'email', cc.email)),
              '[]'::json
            )
            FROM jurisdiction_contacts cc
            WHERE cc.geoid = j.geoid AND cc.category IS NOT NULL
          ) AS category_emails,
          (
            SELECT MAX(rt.created_at)
            FROM report_timeline rt
            JOIN reports r2 ON r2.id = rt.report_id
            WHERE r2.jurisdiction_geoid = j.geoid AND rt.status = 'acknowledged'
          ) AS last_routed_at,
          (
            -- The legacy mail_events signal is OR'd in for threads with no per-contact row (a digest-only
            -- bounce), so an existing bounce never silently disappears. It is scoped to events newer than
            -- the last contact save: mail_events rows are never deleted, so an unscoped EXISTS would pin the
            -- row to 'bounced' forever even after a good address is re-entered.
            EXISTS (
              SELECT 1 FROM jurisdiction_contacts bc
              WHERE bc.geoid = j.geoid AND bc.bounced_at IS NOT NULL
            )
            OR EXISTS (
              SELECT 1 FROM mail_events me
              JOIN mail_threads mt ON mt.id = me.thread_id
              WHERE mt.jurisdiction_geoid = j.geoid AND me.type = 'bounced'
                AND (j.contact_updated_at IS NULL OR me.created_at > j.contact_updated_at)
            )
          ) AS bounced,
          j.layer,
          j.population,
          j.flagged_at,
          j.handle,
          j.forward_subject_template,
          j.forward_body_template,
          COUNT(*) OVER()::text AS filtered_total,
          COALESCE(w.total, 0)::text AS reports_waiting,
          w.oldest_waiting_at,
          ${categoryCountsProjection(sql, "w")}
        FROM jurisdictions j
        LEFT JOIN waiting w ON w.geoid = j.geoid
        WHERE true
        ${search}
        ${methodFilter}
        ${layerFilter}
        ${orderBy}
        OFFSET ${offset}
        LIMIT ${limit + 1}
      `

      const hasMore = rows.length > limit
      const page = (hasMore ? rows.slice(0, limit) : rows).map(toRecord)
      const nextCursor = hasMore ? encodeOffsetCursor(offset + limit) : null

      let total: number | null = null
      let facets: { routed: number; unrouted: number } | null = null
      if (offset === 0) {
        const isDefaultView = args.q === null && args.layer === null
        const cached = args.filter === "all" && isDefaultView ? readDirectoryFacetCache() : null
        if (cached !== null) {
          total = cached.total
          facets = cached.facets
        } else {
          const agg = await sql<{ total: string; routed: string; unrouted: string }[]>`
            SELECT
              COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE ${hasEmailExpr} OR ${hasFormExpr})::text AS routed,
              COUNT(*) FILTER (WHERE NOT (${hasEmailExpr} OR ${hasFormExpr}))::text AS unrouted
            FROM jurisdictions j
            WHERE true ${search} ${layerFilter}
          `
          const a = agg[0]
          total = Number(rows[0]?.filtered_total ?? "0")
          facets = { routed: Number(a?.routed ?? "0"), unrouted: Number(a?.unrouted ?? "0") }
          if (args.filter === "all" && isDefaultView) {
            writeDirectoryFacetCache({ total: Number(a?.total ?? "0"), facets })
          }
        }
      }

      if (shouldIncludeUnmapped(args)) {
        const unmapped = await loadUnmappedAggregate(sql)
        if (unmapped.total > 0) {
          return {
            records: [buildUnmappedRecord(unmapped.total, unmapped.perCategoryCounts), ...page],
            nextCursor,
            total,
            facets,
          }
        }
      }
      return { records: page, nextCursor, total, facets }
    },

    async getGeometry(geoid: string): Promise<JurisdictionGeometryRecord | null> {
      const rows = await sql<
        {
          geoid: string
          name: string
          layer: string
          west: number
          south: number
          east: number
          north: number
          clng: number
          clat: number
          geometry: { type: string; coordinates: unknown[] }
        }[]
      >`
        SELECT
          j.geoid,
          j.name,
          j.layer,
          ST_XMin(j.geom) AS west,
          ST_YMin(j.geom) AS south,
          ST_XMax(j.geom) AS east,
          ST_YMax(j.geom) AS north,
          ST_X(ST_PointOnSurface(j.geom)) AS clng,
          ST_Y(ST_PointOnSurface(j.geom)) AS clat,
          ST_AsGeoJSON(ST_SimplifyPreserveTopology(j.geom, 0.003))::json AS geometry
        FROM jurisdictions j
        WHERE j.geoid = ${geoid} AND j.geom IS NOT NULL
        LIMIT 1
      `
      const r = rows[0]
      if (!r) return null
      return {
        geoid: r.geoid,
        name: r.name,
        layer: r.layer as JurisdictionLayer,
        bbox: [r.west, r.south, r.east, r.north],
        centroid: [r.clng, r.clat],
        geometry: r.geometry,
      }
    },
  }
}
