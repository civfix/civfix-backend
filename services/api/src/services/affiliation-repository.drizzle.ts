import type { Sql } from "../db/client.js"
import { blockedPairExpr } from "./blocks-sql.js"
import { publicServedKeyExpr } from "./media-served-key.js"
import type { AffiliationRepository, AffiliationRow } from "./affiliation-repository.js"

export function makeDrizzleAffiliationRepository(sql: Sql): AffiliationRepository {
  return {
    async primaryAffiliationRows(ids, viewerId) {
      return sql<AffiliationRow[]>`
        SELECT DISTINCT ON (m.user_id)
          m.user_id,
          o.id,
          o.slug,
          o.name,
          o.verified_status,
          o.verified_kind,
          ${publicServedKeyExpr(sql, "am")} AS logo_key
        FROM organization_members m
        JOIN organizations o ON o.id = m.organization_id
        JOIN users u ON u.id = m.user_id
        LEFT JOIN media_assets am ON am.id = o.logo_media_id
        WHERE m.user_id = ANY(${ids}::uuid[])
          AND u.deleted_at IS NULL
          AND o.deleted_at IS NULL
          AND o.suspended_at IS NULL
          AND NOT ${blockedPairExpr(sql, viewerId, sql`m.user_id`)}
        ORDER BY
          m.user_id,
          COALESCE(o.id = u.primary_organization_id, false) DESC,
          m.joined_at ASC,
          o.id ASC
      `
    },
  }
}
