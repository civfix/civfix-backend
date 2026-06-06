/**
 * Postgres-backed OutreachRepository (Phase 2): the production binding of the outreach pipeline's READ
 * seam.
 *
 * Written against the raw postgres-js tag (`Sql`) like the sibling admin repos. Two reads, both over the
 * SAME "waiting report" + "usable contact" notions the discovery queue + the save-and-route path use, so
 * the outreach digest never targets a jurisdiction the rest of the system would consider unrouted:
 *
 *   - loadDigest(geoid): aggregate the geoid's waiting reports (non-deleted, status NOT IN
 *     ('rejected','resolved')) into per-category counts + total + the oldest timestamp, and resolve the
 *     routing recipient (the jurisdiction_contacts default/category-NULL email -> any per-category email
 *     -> the legacy jurisdictions.contact_emails[]). Returns null when there is nothing to send.
 *   - listCandidateGeoids(): every geoid that has BOTH at least one waiting report and a usable contact
 *     (the cron-sweep candidates). Throttle/suppression is applied per geoid by the service.
 *
 * This seam never touches outreach_state (the throttle lives on the MailRepository) and never writes.
 */

import type { Sql } from "../../db/client.js"
import {
  OUTREACH_CATEGORIES,
  type OutreachDigest,
  type OutreachRepository,
} from "./outreach-service.js"
import type { ReportCategory } from "@civfix/shared"

/** A digest aggregate row as selected back from SQL (snake_case; counts as text to avoid bigint). */
interface DigestRow {
  org: string | null
  to_addr: string | null
  total: string
  oldest_waiting_at: Date | null
  cat_trash: string
  cat_recycling: string
  cat_graffiti: string
  cat_hazard: string
  cat_water: string
  cat_other: string
}

function parseCount(value: string | null | undefined): number {
  const n = Number.parseInt(value ?? "0", 10)
  return Number.isNaN(n) ? 0 : n
}

/** Construct the production OutreachRepository over the raw postgres-js tag (`container.getDb().sql`). */
export function makeDrizzleOutreachRepository(sql: Sql): OutreachRepository {
  return {
    async loadDigest(geoid: string): Promise<OutreachDigest | null> {
      // One scan: the waiting-report aggregate for the geoid, plus the resolved routing recipient as a
      // correlated subquery (default contact -> any per-category contact -> legacy contact_emails[0]).
      const rows = await sql<DigestRow[]>`
        SELECT
          j.name AS org,
          COALESCE(
            (
              SELECT dc.email FROM jurisdiction_contacts dc
              WHERE dc.geoid = j.geoid AND dc.category IS NULL
                AND dc.email IS NOT NULL AND dc.email <> ''
              LIMIT 1
            ),
            (
              SELECT cc.email FROM jurisdiction_contacts cc
              WHERE cc.geoid = j.geoid AND cc.category IS NOT NULL
                AND cc.email IS NOT NULL AND cc.email <> ''
              ORDER BY cc.category ASC
              LIMIT 1
            ),
            (
              SELECT e FROM unnest(COALESCE(j.contact_emails, ARRAY[]::text[])) AS e
              WHERE e <> ''
              LIMIT 1
            )
          ) AS to_addr,
          COALESCE(w.total, 0)::text AS total,
          w.oldest_waiting_at,
          COALESCE(w.cat_trash, 0)::text AS cat_trash,
          COALESCE(w.cat_recycling, 0)::text AS cat_recycling,
          COALESCE(w.cat_graffiti, 0)::text AS cat_graffiti,
          COALESCE(w.cat_hazard, 0)::text AS cat_hazard,
          COALESCE(w.cat_water, 0)::text AS cat_water,
          COALESCE(w.cat_other, 0)::text AS cat_other
        FROM jurisdictions j
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) AS total,
            MIN(r.created_at) AS oldest_waiting_at,
            COUNT(*) FILTER (WHERE r.category = 'trash') AS cat_trash,
            COUNT(*) FILTER (WHERE r.category = 'recycling') AS cat_recycling,
            COUNT(*) FILTER (WHERE r.category = 'graffiti') AS cat_graffiti,
            COUNT(*) FILTER (WHERE r.category = 'hazard') AS cat_hazard,
            COUNT(*) FILTER (WHERE r.category = 'water') AS cat_water,
            COUNT(*) FILTER (WHERE r.category = 'other') AS cat_other
          FROM reports r
          WHERE r.jurisdiction_geoid = j.geoid
            AND r.deleted_at IS NULL
            AND r.status NOT IN ('rejected', 'resolved')
        ) w ON true
        WHERE j.geoid = ${geoid}
        LIMIT 1
      `
      const row = rows[0]
      if (!row) return null
      const toAddr = row.to_addr
      const total = parseCount(row.total)
      // Nothing to send when there is no recipient OR no waiting reports.
      if (toAddr === null || toAddr === "" || total === 0) return null

      const counts: Record<ReportCategory, string> = {
        trash: row.cat_trash,
        recycling: row.cat_recycling,
        graffiti: row.cat_graffiti,
        hazard: row.cat_hazard,
        water: row.cat_water,
        other: row.cat_other,
      }
      const perCategory: Partial<Record<ReportCategory, number>> = {}
      for (const category of OUTREACH_CATEGORIES) {
        const n = parseCount(counts[category])
        if (n > 0) perCategory[category] = n
      }
      return {
        geoid,
        org: row.org,
        toAddr,
        perCategory,
        total,
        oldestWaitingAt: row.oldest_waiting_at,
      }
    },

    async listCandidateGeoids(): Promise<string[]> {
      // Every geoid with a waiting report AND a usable contact (default/per-category/legacy). EXISTS
      // guards keep it a single scan over jurisdictions with two correlated existence checks.
      const rows = await sql<{ geoid: string }[]>`
        SELECT j.geoid
        FROM jurisdictions j
        WHERE EXISTS (
            SELECT 1 FROM reports r
            WHERE r.jurisdiction_geoid = j.geoid
              AND r.deleted_at IS NULL
              AND r.status NOT IN ('rejected', 'resolved')
          )
          AND (
            EXISTS (
              SELECT 1 FROM jurisdiction_contacts jc
              WHERE jc.geoid = j.geoid AND jc.email IS NOT NULL AND jc.email <> ''
            )
            OR (
              j.contact_emails IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM unnest(j.contact_emails) AS e WHERE e <> ''
              )
            )
          )
        ORDER BY j.geoid ASC
      `
      return rows.map((r) => r.geoid)
    },
  }
}
