import { createHmac } from "node:crypto"
import { constantTimeStringEqual } from "../../auth/crypto.js"

const TOKEN_VERSION = "v1"

export function mintDonationStatusToken(key: string, donationId: string): string {
  const mac = createHmac("sha256", key).update(`${TOKEN_VERSION}.${donationId}`).digest("base64url")
  return `${TOKEN_VERSION}.${mac}`
}

export function verifyDonationStatusToken(
  key: string,
  donationId: string,
  presented: string | undefined | null,
): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false
  return constantTimeStringEqual(presented, mintDonationStatusToken(key, donationId))
}
