/**
 * Postgres-backed JurisdictionContactsRepository (Phase 2): the production binding of the contacts
 * persistence seam. Raw postgres-js (`Sql`) so save-and-route runs as ONE transaction and so the routing
 * UPDATE/timeline INSERT are issued directly.
 *
 * SAVE & ROUTE (one transaction):
 *   1. upsert jurisdiction_contacts (per-category + default) + mirror the legacy contact_emails[] /
 *      report_form_url - via the shared upsertJurisdictionContacts (also used by discovery save-draft);
 *   2. set jurisdictions.contact_updated_at = now();
 *   3. mark the geoid's open discovery task(s) status = 'done';
 *   4. ROUTE pending pins (ONE set-based CTE statement): every waiting report in the geoid (non-deleted,
 *      status NOT IN ('rejected','resolved','acknowledged','in_progress')) -> status 'acknowledged', with
 *      one report_timeline 'acknowledged' row each noting the route. This is the "saving a contact routes
 *      the next pin" behavior: existing waiting pins flow immediately, and the NEXT pin auto-routes because
 *      the jurisdiction now has a contact (jurisdiction-service.needsDiscovery returns false).
 *
 * C1: save-and-route deliberately does NOT stamp outreach_state.last_outreach_at. The send window is
 * stamped only when a digest is actually sent (OutreachService.runForGeoid), so the immediate outreach the
 * service enqueues after this commit is not throttled-by-construction. Outreach enqueue + audit are the
 * service's / route's responsibility (Jobs + the operator userId).
 */

import type { Sql } from "../../db/client.js"
import { decodeCursor, encodeCursor, clampLimit } from "./pagination.js"
import { writeAudit } from "./audit.js"
import { upsertJurisdictionContacts } from "./discovery-repository.drizzle.js"
import {
  buildUnmappedRecord,
  directoryMethod,
  shouldIncludeUnmapped,
  type JurisdictionContactsRepository,
  type JurisdictionDirectoryRecord,
  type ListDirectoryArgs,
  type SaveContactsInput,
} from "./jurisdiction-contacts-service.js"
import type { JurisdictionLayer, ReportCategory } from "@civfix/shared"
import { likeContains } from "./like.js"

/** The 6 canonical categories (local copy; the directory record maps per-category contacts by these). */
const CATEGORIES: readonly ReportCategory[] = [
  "trash",
  "recycling",
  "graffiti",
  "hazard",
  "water",
  "other",
]

/** A directory row as selected (snake_case). */
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
  // COUNT(*) comes back from postgres-js as a string; parsed in toRecord.
  reports_waiting: string
  cat_trash: string
  cat_recycling: string
  cat_graffiti: string
  cat_hazard: string
  cat_water: string
  cat_other: string
}

function toRecord(r: DirectoryRow): JurisdictionDirectoryRecord {
  const categoryContacts = (r.category_emails ?? [])
    .filter((c): c is { category: ReportCategory; email: string | null } =>
      (CATEGORIES as readonly string[]).includes(c.category),
    )
    .map((c) => ({ category: c.category, email: c.email }))
  const waitingByCat: Record<ReportCategory, string> = {
    trash: r.cat_trash,
    recycling: r.cat_recycling,
    graffiti: r.cat_graffiti,
    hazard: r.cat_hazard,
    water: r.cat_water,
    other: r.cat_other,
  }
  const perCategoryCounts: Partial<Record<ReportCategory, number>> = {}
  for (const c of CATEGORIES) {
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
  }
}

/**
 * Aggregate the WAITING reports whose jurisdiction did not resolve — jurisdiction_geoid IS NULL OR points
 * at a geoid no longer in the jurisdictions table (orphaned) — for the synthetic Unmapped directory row.
 * Uses the SAME "waiting" predicate as the directory's per-jurisdiction LATERAL (open + un-routed) so the
 * counts are consistent. The LEFT JOIN ... WHERE j.geoid IS NULL covers both the NULL and orphaned cases.
 */
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
    water: r?.cat_water,
    other: r?.cat_other,
  }
  const perCategoryCounts: Partial<Record<ReportCategory, number>> = {}
  for (const c of CATEGORIES) {
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
      return sql.begin(async (tx) => {
        // 1. contacts + legacy mirror.
        await upsertJurisdictionContacts(tx, geoid, input.contacts, input.defaultEmails, input.formUrl)

        // 2. contact_updated_at.
        await tx`UPDATE jurisdictions SET contact_updated_at = now() WHERE geoid = ${geoid}`

        // 3. resolve open discovery task(s).
        const tasks = await tx<{ id: string }[]>`
          UPDATE jurisdiction_discovery_tasks
          SET status = 'done'
          WHERE geoid = ${geoid} AND status <> 'done'
          RETURNING id
        `
        const taskResolved = tasks.length > 0

        // 4. route waiting pins in ONE set-based statement (M6): a CTE flips every waiting report to
        // 'acknowledged' (RETURNING the ids), and the outer INSERT ... SELECT writes one routed
        // report_timeline row per just-acknowledged report. This is two-statements-as-one regardless of N
        // (no per-report round trip), so a hot un-onboarded geoid with many waiting pins does not hold the
        // transaction open across a JS loop.
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

        // NOTE (C1): we deliberately do NOT stamp outreach_state.last_outreach_at here. Pre-stamping the
        // send window at save time made the immediate outreach ALWAYS throttled (the enqueue + the worker
        // both re-read this row and saw now()), so the first digest could never go out on save. The window
        // is stamped ONLY when a digest is actually sent (OutreachService.runForGeoid after a successful
        // send). With no stamp here, the service's enqueue fires and the worker sends, then stamps for real.

        // 5. audit the save IN-TX (H4): "did + recorded" is atomic - a failed audit rolls back the routing.
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
    },

    async patch(
      geoid: string,
      input: {
        contacts?: Partial<Record<ReportCategory, string | null>>
        defaultEmails?: string[]
        formUrl?: string | null
        notes?: string | null
        flagged?: boolean
        flagReason?: string | null
      },
      audit: { actorId: string | null },
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
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
        // Flag / unflag for operator review: set stamps flagged_at + reason; clear nulls both.
        if (input.flagged !== undefined) {
          if (input.flagged) {
            await tx`UPDATE jurisdictions SET flagged_at = now(), flag_reason = ${input.flagReason ?? null} WHERE geoid = ${geoid}`
          } else {
            await tx`UPDATE jurisdictions SET flagged_at = NULL, flag_reason = NULL WHERE geoid = ${geoid}`
          }
        }
        // Audit the patch IN-TX (H4), recording which fields changed.
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

    async listDirectory(
      args: ListDirectoryArgs,
    ): Promise<{ records: JurisdictionDirectoryRecord[]; nextCursor: string | null }> {
      // Directory rows: jurisdictions with their default + per-category contacts, last-routed time (from
      // the most recent acknowledged report_timeline in the geoid), and a bounce flag (from a bounced
      // mail_events row for the geoid's thread). Keyset over (geoid) so the page is stable.
      const search =
        args.q !== null
          ? (() => {
              const like = likeContains(args.q)
              return sql`AND (j.name ILIKE ${like} ESCAPE '\\' OR j.geoid ILIKE ${like} ESCAPE '\\')`
            })()
          : sql``
      const anchor = decodeCursor(args.cursor)
      const after = anchor ? sql`AND j.geoid > ${anchor.id}` : sql``
      const limit = clampLimit(args.limit)

      // Method facet pushed into the WHERE (was JS-only, post-LIMIT). directoryMethod is derivable from
      // the already-joined columns, so mirroring its rule here keeps LIMIT counting only matching rows and
      // the geoid cursor aligned (a sparse facet no longer yields near-empty pages -> a client refetch
      // storm). The SQL must match jurisdiction-contacts-service.directoryMethod EXACTLY:
      //   hasEmail = j.contact_emails has a non-blank entry OR a per-category jurisdiction_contacts row has
      //              a non-blank email; 'email' = hasEmail; 'form' = !hasEmail AND a non-blank
      //              report_form_url; 'none' = neither. (btrim(...) <> '' mirrors the JS .trim() !== "".)
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
              ? sql`AND NOT ${hasEmailExpr} AND NOT ${hasFormExpr}`
              : sql``

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
          EXISTS (
            SELECT 1 FROM mail_events me
            JOIN mail_threads mt ON mt.id = me.thread_id
            WHERE mt.jurisdiction_geoid = j.geoid AND me.type = 'bounced'
          ) AS bounced,
          j.layer,
          j.population,
          j.flagged_at,
          COALESCE(w.total, 0)::text AS reports_waiting,
          COALESCE(w.cat_trash, 0)::text AS cat_trash,
          COALESCE(w.cat_recycling, 0)::text AS cat_recycling,
          COALESCE(w.cat_graffiti, 0)::text AS cat_graffiti,
          COALESCE(w.cat_hazard, 0)::text AS cat_hazard,
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
            COUNT(*) FILTER (WHERE r.category = 'water') AS cat_water,
            COUNT(*) FILTER (WHERE r.category = 'other') AS cat_other
          FROM reports r
          WHERE r.jurisdiction_geoid = j.geoid
            AND r.deleted_at IS NULL
            AND r.status NOT IN ('rejected', 'resolved', 'acknowledged', 'in_progress')
        ) w ON true
        WHERE true
        ${search}
        ${after}
        ${methodFilter}
        ORDER BY j.geoid ASC
        LIMIT ${limit + 1}
      `

      let records = rows.map(toRecord)
      // The method facet is now applied in SQL (the ${methodFilter} fragment above), so LIMIT counts only
      // matching rows and the geoid cursor stays aligned. This JS pass is kept only as a belt-and-suspenders
      // check that re-derives the facet from the projected record via the service's directoryMethod (one
      // definition of the rule); against the SQL predicate it should be a no-op. (N2.)
      if (args.filter !== "all") {
        records = records.filter((r) => directoryMethod(r) === args.filter)
      }
      const hasMore = rows.length > limit
      const page = hasMore ? records.slice(0, limit) : records
      const last = hasMore ? rows[limit - 1] : undefined
      const nextCursor = last ? encodeCursor({ createdAt: new Date(0), id: last.geoid }) : null

      // Prepend the synthetic "Unmapped / Unknown jurisdiction" row on the first page so reports whose
      // jurisdiction did not resolve (NULL or orphaned geoid) are visible + triageable. Suppressed when
      // there are none waiting. (Not part of the keyset; it pins to the top of the first page.)
      if (shouldIncludeUnmapped(args)) {
        const unmapped = await loadUnmappedAggregate(sql)
        if (unmapped.total > 0) {
          return {
            records: [buildUnmappedRecord(unmapped.total, unmapped.perCategoryCounts), ...page],
            nextCursor,
          }
        }
      }
      return { records: page, nextCursor }
    },
  }
}
