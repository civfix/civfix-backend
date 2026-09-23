import type { Sql } from "../../db/client.js"
import {
  OUTREACH_CATEGORIES,
  type OutreachDigest,
  type OutreachRepository,
} from "./outreach-service.js"
import {
  categoryCountsFragment,
  categoryCountsProjection,
  parseCategoryCounts,
  parseCount,
  type CategoryCountRow,
} from "./category-counts.js"
import { legacyContactEmailUsable } from "./jurisdiction-contacts-repository.drizzle.js"

interface DigestRow extends CategoryCountRow {
  org: string | null
  to_addr: string | null
  total: string
  oldest_waiting_at: Date | null
}

export function makeDrizzleOutreachRepository(sql: Sql): OutreachRepository {
  return {
    async loadDigest(geoid: string): Promise<OutreachDigest | null> {
      const rows = await sql<DigestRow[]>`
        SELECT
          j.name AS org,
          COALESCE(
            (
              SELECT dc.email FROM jurisdiction_contacts dc
              WHERE dc.geoid = j.geoid AND dc.category IS NULL
                AND dc.email IS NOT NULL AND dc.email <> ''
                AND dc.bounced_at IS NULL
              LIMIT 1
            ),
            (
              SELECT cc.email FROM jurisdiction_contacts cc
              WHERE cc.geoid = j.geoid AND cc.category IS NOT NULL
                AND cc.email IS NOT NULL AND cc.email <> ''
                AND cc.bounced_at IS NULL
              ORDER BY COALESCE(
                array_position(${[...OUTREACH_CATEGORIES] as string[]}::text[], cc.category),
                2147483647
              ), cc.category ASC
              LIMIT 1
            ),
            (
              SELECT e FROM unnest(COALESCE(j.contact_emails, ARRAY[]::text[])) AS e
              WHERE e <> ''
                AND ${legacyContactEmailUsable(sql, {
                  email: sql`e`,
                  geoid: sql`j.geoid`,
                  contactUpdatedAt: sql`j.contact_updated_at`,
                })}
              LIMIT 1
            )
          ) AS to_addr,
          COALESCE(w.total, 0)::text AS total,
          w.oldest_waiting_at,
          ${categoryCountsProjection(sql, "w")}
        FROM jurisdictions j
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) AS total,
            MIN(r.created_at) AS oldest_waiting_at,
            ${categoryCountsFragment(sql, "r")}
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
      if (toAddr === null || toAddr === "" || total === 0) return null

      return {
        geoid,
        org: row.org,
        toAddr,
        perCategory: parseCategoryCounts(row),
        total,
        oldestWaitingAt: row.oldest_waiting_at,
      }
    },

    async listCandidateGeoids(limit?: number): Promise<string[]> {
      const cap = limit !== undefined && limit > 0 ? limit : null
      const rows = await sql<{ geoid: string }[]>`
        WITH candidate AS (
          SELECT DISTINCT r.jurisdiction_geoid AS geoid
          FROM reports r
          WHERE r.deleted_at IS NULL
            AND r.status NOT IN ('rejected', 'resolved')
            AND r.jurisdiction_geoid IS NOT NULL
        )
        SELECT c.geoid
        FROM candidate c
        LEFT JOIN outreach_state os ON os.geoid = c.geoid
        WHERE COALESCE(os.suppressed, false) = false
          AND (
            EXISTS (
              SELECT 1 FROM jurisdiction_contacts jc
              WHERE jc.geoid = c.geoid AND jc.email IS NOT NULL AND jc.email <> ''
                AND jc.bounced_at IS NULL
            )
            OR EXISTS (
              SELECT 1 FROM jurisdictions j
              WHERE j.geoid = c.geoid
                AND j.contact_emails IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM unnest(COALESCE(j.contact_emails, ARRAY[]::text[])) AS e
                  WHERE e <> ''
                    AND ${legacyContactEmailUsable(sql, {
                      email: sql`e`,
                      geoid: sql`j.geoid`,
                      contactUpdatedAt: sql`j.contact_updated_at`,
                    })}
                )
            )
          )
        ORDER BY os.last_outreach_at ASC NULLS FIRST, c.geoid ASC
        ${cap !== null ? sql`LIMIT ${cap}` : sql``}
      `
      return rows.map((r) => r.geoid)
    },

    async claimOutreachWindow(
      geoid: string,
      window: { at: Date; windowStart: Date },
    ): Promise<boolean> {
      const rows = await sql<{ geoid: string }[]>`
        INSERT INTO outreach_state (geoid, last_outreach_at, suppressed)
        VALUES (${geoid}, ${window.at}, false)
        ON CONFLICT (geoid) DO UPDATE SET last_outreach_at = ${window.at}
        WHERE outreach_state.suppressed = false
          AND (
            outreach_state.last_outreach_at IS NULL
            OR outreach_state.last_outreach_at < ${window.windowStart}
          )
        RETURNING geoid
      `
      return rows.length > 0
    },
  }
}
