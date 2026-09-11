import type { OrganizationRefDTO, PersonDTO } from "@civfix/shared"
import type { Sql } from "../db/client.js"
import { blockedPairExpr } from "./hidden-identity.js"
import { PRESIGN_CONCURRENCY, mapWithLimit } from "./media-presign.js"

export type PrimaryAffiliations = ReadonlyMap<string, OrganizationRefDTO>

export const NO_AFFILIATIONS: PrimaryAffiliations = new Map()

export type AffiliationLoader = (
  userIds: readonly string[],
  viewerId: string | null,
) => Promise<PrimaryAffiliations>

export type LogoPresigner = (key: string) => Promise<string>

interface AffiliationRow {
  user_id: string
  id: string
  slug: string
  name: string
  verified_status: string
  verified_kind: OrganizationRefDTO["verifiedKind"]
  logo_key: string | null
}

export async function loadPrimaryAffiliations(
  sql: Sql,
  presignLogo: LogoPresigner | undefined,
  userIds: readonly string[],
  viewerId: string | null,
): Promise<PrimaryAffiliations> {
  const ids = [...new Set(userIds)]
  if (ids.length === 0) return NO_AFFILIATIONS

  const rows = await sql<AffiliationRow[]>`
    SELECT DISTINCT ON (m.user_id)
      m.user_id,
      o.id,
      o.slug,
      o.name,
      o.verified_status,
      o.verified_kind,
      am.r2_key AS logo_key
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
  if (rows.length === 0) return NO_AFFILIATIONS

  const logoUrls = new Map<string, string>()
  if (presignLogo !== undefined) {
    const keys = [...new Set(rows.map((r) => r.logo_key).filter((k): k is string => k !== null))]
    const urls = await mapWithLimit(keys, PRESIGN_CONCURRENCY, (key) => presignLogo(key))
    keys.forEach((key, i) => {
      const url = urls[i]
      if (url !== undefined) logoUrls.set(key, url)
    })
  }

  const out = new Map<string, OrganizationRefDTO>()
  for (const row of rows) {
    out.set(row.user_id, {
      id: row.id,
      slug: row.slug,
      name: row.name,
      logoUrl: row.logo_key === null ? null : (logoUrls.get(row.logo_key) ?? null),
      verified: row.verified_status === "verified",
      verifiedKind: row.verified_kind,
    })
  }
  return out
}

export function makeAffiliationLoader(
  sql: Sql,
  presignLogo: LogoPresigner | undefined,
): AffiliationLoader {
  return (userIds, viewerId) => loadPrimaryAffiliations(sql, presignLogo, userIds, viewerId)
}

export async function attachAffiliations<T extends PersonDTO>(
  load: AffiliationLoader | undefined,
  people: T[],
  viewerId: string | null,
): Promise<T[]> {
  if (load === undefined || people.length === 0) return people
  const affiliations = await load(
    people.map((p) => p.id),
    viewerId,
  )
  if (affiliations.size === 0) return people
  return people.map((person) => withAffiliation(person, affiliations))
}

export function withAffiliation<T extends PersonDTO>(
  person: T,
  affiliations: PrimaryAffiliations,
): T {
  const organization = affiliations.get(person.id)
  if (organization === undefined) return person
  return { ...person, organization }
}
