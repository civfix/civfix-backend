import type { CleanupDTO } from "@civfix/shared"
import type { Container } from "../di.js"
import { attachRegistrationFields } from "./host/registration-dto.js"
import { attachDonationOrg } from "./payments/donation-org-dto.js"
import { withAffiliation } from "./affiliation.js"

export async function attachOrganizerAffiliations(
  container: Container,
  dtos: CleanupDTO[],
): Promise<CleanupDTO[]> {
  if (dtos.length === 0) return dtos
  const affiliations = await container.getAffiliationLoader()(dtos.map((d) => d.organizer.id))
  if (affiliations.size === 0) return dtos
  return dtos.map((dto) => ({
    ...dto,
    organizer: withAffiliation(dto.organizer, affiliations),
  }))
}

export async function enrichCleanupDTOs(
  container: Container,
  dtos: CleanupDTO[],
  viewerUserId: string | null,
): Promise<CleanupDTO[]> {
  if (dtos.length === 0) return dtos
  const sql = container.getDb().sql
  const withRegistration = await attachRegistrationFields(sql, dtos, viewerUserId)
  const withOrganizer = await attachOrganizerAffiliations(container, withRegistration)
  if (!container.env.PAYMENTS_ENABLED) return withOrganizer
  return attachDonationOrg(sql, withOrganizer)
}
