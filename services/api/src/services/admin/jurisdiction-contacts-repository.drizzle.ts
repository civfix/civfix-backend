
import type { Sql } from "../../db/client.js"
import { decodeOffsetCursor, encodeOffsetCursor, clampLimit } from "./pagination.js"
import { writeAudit } from "./audit.js"
import { upsertJurisdictionContacts } from "./discovery-repository.drizzle.js"
import { buildUnmappedRecord, shouldIncludeUnmapped } from "./jurisdiction-directory-projection.js"
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
import { likeContains } from "./like.js"
import { DISCOVERY_CATEGORIES } from "./discovery-service.js"

const DIRECTORY_FACET_TTL_MS = 30_000

interface DirectoryFacetAggregate {
  total: number
  facets: { routed: number; unrouted: number }
}

let defaultFacetCache: { at: number; value: DirectoryFacetAggregate } | null = null

function readDefaultFacetCache(): DirectoryFacetAggregate | null {
  if (defaultFacetCache === null) return null
  if (Date.now() - defaultFacetCache.at > DIRECTORY_FACET_TTL_MS) {
    defaultFacetCache = null
    return null
  }
  return defaultFacetCache.value
}

function writeDefaultFacetCache(value: DirectoryFacetAggregate): void {
  defaultFacetCache = { at: Date.now(), value }
}

function invalidateDefaultFacetCache(): void {
  defaultFacetCache = null
}

interface DirectoryRow {
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
  reports_waiting: string
  cat_trash: string
  cat_recycling: string
  cat_graffiti: string
  cat_hazard: string
  cat_encampment: string
  cat_water: string
  cat_other: string
}

function toRecord(r: DirectoryRow): JurisdictionDirectoryRecord {
  const categoryContacts = (r.category_emails ?? [])
    .filter((c): c is { category: ReportCategory; email: string | null } =>
      (DISCOVERY_CATEGORIES as readonly string[]).includes(c.category),
    )
    .map((c) => ({ category: c.category, email: c.email }))
  const waitingByCat: Record<ReportCategory, string> = {
    trash: r.cat_trash,
    recycling: r.cat_recycling,
    graffiti: r.cat_graffiti,
    hazard: r.cat_hazard,
    encampment: r.cat_encampment,
    water: r.cat_water,
    other: r.cat_other,
  }
  const perCategoryCounts: Partial<Record<ReportCategory, number>> = {}
  for (const c of DISCOVERY_CATEGORIES) {
    const n = Number(waitingByCat[c] ?? "0")
    if (n > 0) perCategoryCounts[c] = n
  }
  return {
    geoid: r.geoid,
    name: r.name,
    layer: r.layer as JurisdictionLayer,
    population: r.population,
    defaultEmails: r.default_emails ?? [],
    categoryContacts,
    hasDefaultContact: r.has_default_contact,
    reportFormUrl: r.report_form_url,
    reportsWaiting: Number(r.reports_waiting ?? "0"),
    perCategoryCounts,
    lastRoutedAt: r.last_routed_at,
    bounced: r.bounced,
    contactUpdatedAt: r.contact_updated_at,
    flaggedAt: r.flagged_at,
    handle: r.handle,
  }
}

async function loadUnmappedAggregate(
  sql: Sql,
): Promise<{ total: number; perCategoryCounts: Partial<Record<ReportCategory, number>> }> {
  const rows = await sql<
    {
      total: string
      cat_trash: string
      cat_recycling: string
      cat_graffiti: string
      cat_hazard: string
      cat_encampment: string
      cat_water: string
      cat_other: string
    }[]
  >`
    SELECT
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE r.category = 'trash')::text AS cat_trash,
      COUNT(*) FILTER (WHERE r.category = 'recycling')::text AS cat_recycling,
      COUNT(*) FILTER (WHERE r.category = 'graffiti')::text AS cat_graffiti,
      COUNT(*) FILTER (WHERE r.category = 'hazard')::text AS cat_hazard,
      COUNT(*) FILTER (WHERE r.category = 'encampment')::text AS cat_encampment,
      COUNT(*) FILTER (WHERE r.category = 'water')::text AS cat_water,
      COUNT(*) FILTER (WHERE r.category = 'other')::text AS cat_other
    FROM reports r
    LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
    WHERE r.deleted_at IS NULL
      AND r.status NOT IN ('rejected', 'resolved', 'acknowledged', 'in_progress')
      AND (r.jurisdiction_geoid IS NULL OR j.geoid IS NULL)
  `
  const r = rows[0]
  const total = Number(r?.total ?? "0")
  const waitingByCat: Record<ReportCategory, string | undefined> = {
    trash: r?.cat_trash,
    recycling: r?.cat_recycling,
    graffiti: r?.cat_graffiti,
    hazard: r?.cat_hazard,
    encampment: r?.cat_encampment,
    water: r?.cat_water,
    other: r?.cat_other,
  }
  const perCategoryCounts: Partial<Record<ReportCategory, number>> = {}
  for (const c of DISCOVERY_CATEGORIES) {
    const n = Number(waitingByCat[c] ?? "0")
    if (n > 0) perCategoryCounts[c] = n
  }
  return { total, perCategoryCounts }
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
    ): Promise<{ routedReports: number; taskResolved: boolean }> {
      const result = await sql.begin(async (tx) => {
        await upsertJurisdictionContacts(tx, geoid, input.contacts, input.defaultEmails, input.formUrl)
        await tx`UPDATE jurisdictions SET contact_updated_at = now() WHERE geoid = ${geoid}`

        const tasks = await tx<{ id: string }[]>`
          UPDATE jurisdiction_discovery_tasks
          SET status = 'done'
          WHERE geoid = ${geoid} AND status <> 'done'
          RETURNING id
        `
        const taskResolved = tasks.length > 0

        const routed = await tx<{ id: string }[]>`
          WITH routed AS (
            UPDATE reports
            SET status = 'acknowledged'
            WHERE jurisdiction_geoid = ${geoid}
              AND deleted_at IS NULL
              AND status NOT IN ('rejected', 'resolved', 'acknowledged', 'in_progress')
            RETURNING id
          ),
          timeline AS (
            INSERT INTO report_timeline (report_id, status, note)
            SELECT id, 'acknowledged', 'Routed to jurisdiction contact' FROM routed
          )
          SELECT id FROM routed
        `


        await writeAudit(tx, {
          actorId: audit.actorId,
          action: "discovery.contacts_saved",
          target: `jurisdiction:${geoid}`,
          meta: {
            geoid,
            categories: Object.keys(input.contacts),
            defaultEmails: input.defaultEmails,
            routedReports: routed.length,
            taskResolved,
          },
        })

        return { routedReports: routed.length, taskResolved }
      })
      invalidateDefaultFacetCache()
      return result
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
            await tx`UPDATE jurisdictions SET handle = ${handle} WHERE geoid = ${geoid}`
          }
        }
        await writeAudit(tx, {
          actorId: audit.actorId,
          action: "jurisdiction.patched",
          target: `jurisdiction:${geoid}`,
          meta: {
            geoid,
            fields: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined),
          },
        })
        return true
      })
      invalidateDefaultFacetCache()
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
        args.q !== null
          ? (() => {
              const like = likeContains(args.q)
              return sql`AND (j.name ILIKE ${like} ESCAPE '\\' OR j.geoid ILIKE ${like} ESCAPE '\\')`
            })()
          : sql``
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
                : sql``

      const layerFilter = args.layer !== null ? sql`AND j.layer = ${args.layer}` : sql``

      const orderBy =
        args.sort === "reports"
          ? sql`ORDER BY COALESCE(w.total, 0) DESC, j.geoid ASC`
          : args.sort === "name"
            ? sql`ORDER BY j.name ASC, j.geoid ASC`
            : sql`ORDER BY COALESCE(j.population, 0) DESC, j.geoid ASC`

      const rows = await sql<DirectoryRow[]>`
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
            JOIN reports r ON r.id = rt.report_id
            WHERE r.jurisdiction_geoid = j.geoid AND rt.status = 'acknowledged'
          ) AS last_routed_at,
          (
            -- A contact is 'bounced' when ANY of the geoid's contact rows has a bounce marker (the inbound
            -- bounce handler stamps jurisdiction_contacts.bounced_at; this takes precedence over
            -- verified/pending). The legacy mail_events signal is OR'd in for threads with no per-contact
            -- row (e.g. a digest-only bounce), so an existing bounce never silently disappears.
            EXISTS (
              SELECT 1 FROM jurisdiction_contacts bc
              WHERE bc.geoid = j.geoid AND bc.bounced_at IS NOT NULL
            )
            OR EXISTS (
              SELECT 1 FROM mail_events me
              JOIN mail_threads mt ON mt.id = me.thread_id
              WHERE mt.jurisdiction_geoid = j.geoid AND me.type = 'bounced'
            )
          ) AS bounced,
          j.layer,
          j.population,
          j.flagged_at,
          j.handle,
          COALESCE(w.total, 0)::text AS reports_waiting,
          COALESCE(w.cat_trash, 0)::text AS cat_trash,
          COALESCE(w.cat_recycling, 0)::text AS cat_recycling,
          COALESCE(w.cat_graffiti, 0)::text AS cat_graffiti,
          COALESCE(w.cat_hazard, 0)::text AS cat_hazard,
          COALESCE(w.cat_encampment, 0)::text AS cat_encampment,
          COALESCE(w.cat_water, 0)::text AS cat_water,
          COALESCE(w.cat_other, 0)::text AS cat_other
        FROM jurisdictions j
        LEFT JOIN LATERAL (
          -- "Waiting" = open, un-routed reports (the same statuses save-and-route would flip): excludes
          -- acknowledged/in_progress (already routed) and rejected/resolved (closed). So reportsWaiting
          -- is the backlog needing a contact, and it drops to 0 once the jurisdiction is routed.
          SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE r.category = 'trash') AS cat_trash,
            COUNT(*) FILTER (WHERE r.category = 'recycling') AS cat_recycling,
            COUNT(*) FILTER (WHERE r.category = 'graffiti') AS cat_graffiti,
            COUNT(*) FILTER (WHERE r.category = 'hazard') AS cat_hazard,
            COUNT(*) FILTER (WHERE r.category = 'encampment') AS cat_encampment,
            COUNT(*) FILTER (WHERE r.category = 'water') AS cat_water,
            COUNT(*) FILTER (WHERE r.category = 'other') AS cat_other
          FROM reports r
          WHERE r.jurisdiction_geoid = j.geoid
            AND r.deleted_at IS NULL
            AND r.status NOT IN ('rejected', 'resolved', 'acknowledged', 'in_progress')
        ) w ON true
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
        const cached = isDefaultView ? readDefaultFacetCache() : null
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
          total = Number(a?.total ?? "0")
          facets = { routed: Number(a?.routed ?? "0"), unrouted: Number(a?.unrouted ?? "0") }
          if (isDefaultView) writeDefaultFacetCache({ total, facets })
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

    async markContactBounced(email: string): Promise<void> {
      await sql`
        UPDATE jurisdiction_contacts
        SET bounced_at = now()
        WHERE email = ${email}
      `
    },
  }
}
