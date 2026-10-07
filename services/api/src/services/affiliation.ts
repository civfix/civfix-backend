import type { OrganizationRefDTO, PersonDTO } from "@civfix/shared"
import type { Sql } from "../db/client.js"
import { makeDrizzleAffiliationRepository } from "./affiliation-repository.drizzle.js"
import { mapWithLimit } from "../lib/concurrency.js"
import { PRESIGN_CONCURRENCY } from "./media-presign.js"
import { presentIds } from "./present-ids.js"

export type PrimaryAffiliations = ReadonlyMap<string, OrganizationRefDTO>

export const NO_AFFILIATIONS: PrimaryAffiliations = new Map()

export type AffiliationLoader = (
  userIds: readonly string[],
  viewerId: string | null,
) => Promise<PrimaryAffiliations>

export type LogoPresigner = (key: string) => Promise<string>

export async function loadPrimaryAffiliations(
  sql: Sql,
  presignLogo: LogoPresigner | undefined,
  userIds: readonly (string | null | undefined)[],
  viewerId: string | null,
): Promise<PrimaryAffiliations> {
  const ids = presentIds(userIds)
  if (ids.length === 0) return NO_AFFILIATIONS

  const rows = await makeDrizzleAffiliationRepository(sql).primaryAffiliationRows(ids, viewerId)
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
