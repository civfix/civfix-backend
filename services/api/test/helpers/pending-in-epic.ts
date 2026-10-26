// Registry entries the pinned contract snapshot already has but whose routes a later PR of the same epic
// registers, each with that PR. The route-coverage and CSRF-pairing checks skip them until it lands.
export const PENDING_IN_EPIC: Readonly<Record<string, string>> = {
  getMyLegalStatus: "#239",
  acceptLegal: "#239",
}
