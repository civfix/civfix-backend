import type { OrganizationRefDTO } from "@civfix/shared"

export interface AffiliationRow {
  user_id: string
  id: string
  slug: string
  name: string
  verified_status: string
  verified_kind: OrganizationRefDTO["verifiedKind"]
  logo_key: string | null
}

export interface AffiliationRepository {
  primaryAffiliationRows(ids: string[], viewerId: string | null): Promise<AffiliationRow[]>
}
