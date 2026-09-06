import type { CleanupDonationOrgRef } from "@civfix/shared"
import type { Queryable } from "../../db/client.js"

interface DonationOrgRow {
  cleanup_id: string
  slug: string
  name: string
  enabled: boolean
}

export interface DonationOrgAttachable {
  id: string
  donationOrg?: CleanupDonationOrgRef | null
}

export async function attachDonationOrg<T extends DonationOrgAttachable>(
  sql: Queryable,
  dtos: readonly T[],
): Promise<T[]> {
  if (dtos.length === 0) return [...dtos]
  const ids = dtos.map((dto) => dto.id)
  const rows = await sql<DonationOrgRow[]>`
    SELECT c.id AS cleanup_id, o.slug, o.name,
           (s.enabled AND a.onboarding_state IN ('ready','at_risk')) AS enabled
      FROM cleanups c
      JOIN organizations o ON o.id = c.organization_id AND o.deleted_at IS NULL
      JOIN org_donation_settings s ON s.organization_id = o.id
      JOIN org_stripe_accounts a ON a.organization_id = o.id AND a.deauthorized_at IS NULL
     WHERE c.id = ANY(${ids}::uuid[])`

  const byCleanup = new Map(
    rows.map((row) => [row.cleanup_id, { slug: row.slug, name: row.name, enabled: row.enabled }]),
  )
  return dtos.map((dto) => {
    const donationOrg = byCleanup.get(dto.id)
    return donationOrg === undefined ? dto : { ...dto, donationOrg }
  })
}
