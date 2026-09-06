import type { CleanupDTO } from "@civfix/shared"
import type { Container } from "../di.js"
import { attachRegistrationFields } from "./host/registration-dto.js"
import { attachDonationOrg } from "./payments/donation-org-dto.js"

export async function enrichCleanupDTOs(
  container: Container,
  dtos: CleanupDTO[],
  viewerUserId: string | null,
): Promise<CleanupDTO[]> {
  if (dtos.length === 0) return dtos
  const sql = container.getDb().sql
  const withRegistration = await attachRegistrationFields(sql, dtos, viewerUserId)
  if (!container.env.PAYMENTS_ENABLED) return withRegistration
  return attachDonationOrg(sql, withRegistration)
}
