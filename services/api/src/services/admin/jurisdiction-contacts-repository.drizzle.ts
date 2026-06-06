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
  directoryMethod,
  type JurisdictionContactsRepository,
  type JurisdictionDirectoryRecord,
  type ListDirectoryArgs,
  type SaveContactsInput,
} from "./jurisdiction-contacts-service.js"
import type { ReportCategory } from "@civfix/shared"

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
  default_emails: string[] | null
  report_form_url: string | null
  contact_updated_at: Date | null
  has_default_contact: boolean
  category_emails: { category: string; email: string | null }[] | null
  last_routed_at: Date | null
  bounced: boolean
}

function toRecord(r: DirectoryRow): JurisdictionDirectoryRecord {
  const categoryContacts = (r.category_emails ?? [])
    .filter((c): c is { category: ReportCategory; email: string | null } =>
      (CATEGORIES as readonly string[]).includes(c.category),
    )
    .map((c) => ({ category: c.category, email: c.email }))
  return {
    geoid: r.geoid,
    name: r.name,
    defaultEmails: r.default_emails ?? [],
    categoryContacts,
    hasDefaultContact: r.has_default_contact,
    reportFormUrl: r.report_form_url,
    lastRoutedAt: r.last_routed_at,
    bounced: r.bounced,
    contactUpdatedAt: r.contact_updated_at,
  }
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
          ? sql`AND (j.name ILIKE ${"%" + args.q + "%"} OR j.geoid ILIKE ${"%" + args.q + "%"})`
          : sql``
      const anchor = decodeCursor(args.cursor)
      const after = anchor ? sql`AND j.geoid > ${anchor.id}` : sql``
      const limit = clampLimit(args.limit)

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
          ) AS bounced
        FROM jurisdictions j
        WHERE true
        ${search}
        ${after}
        ORDER BY j.geoid ASC
        LIMIT ${limit + 1}
      `

      let records = rows.map(toRecord)
      // The method facet is computed from the contact posture, so filter in JS after projection (the
      // directory is small; one row per jurisdiction). Cursor paging stays on geoid. (N2: reuse the
      // service's directoryMethod so the rule has one definition.)
      if (args.filter !== "all") {
        records = records.filter((r) => directoryMethod(r) === args.filter)
      }
      if (rows.length <= limit) {
        return { records, nextCursor: null }
      }
      const page = records.slice(0, limit)
      const last = rows[limit - 1]
      const nextCursor = last ? encodeCursor({ createdAt: new Date(0), id: last.geoid }) : null
      return { records: page, nextCursor }
    },
  }
}
