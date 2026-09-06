import { createHash, createHmac } from "node:crypto"
import { constantTimeStringEqual } from "../../auth/crypto.js"

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export const TICKET_TOKEN_BYTES = 16

export const TICKET_TOKEN_LENGTH = 26

export interface TicketTokenSigner {
  tokenFor(seatId: string): string
  hashOf(token: string): string
  hashFor(seatId: string): string
  verify(seatId: string, token: string): boolean
}

function base32(bytes: Buffer): string {
  let out = ""
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32_ALPHABET[(buffer >> bits) & 31]
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31]
  return out
}

export function normalizeTicketToken(raw: string): string {
  return raw.replace(/[\s-]+/gu, "").toUpperCase()
}

export function makeTicketTokenSigner(secret: string): TicketTokenSigner {
  if (secret.length === 0) {
    throw new Error("ticket tokens: TICKET_TOKEN_SECRET is empty")
  }

  function tokenFor(seatId: string): string {
    const mac = createHmac("sha256", secret).update(seatId).digest()
    return base32(mac.subarray(0, TICKET_TOKEN_BYTES))
  }

  function hashOf(token: string): string {
    return createHash("sha256").update(normalizeTicketToken(token)).digest("hex")
  }

  return {
    tokenFor,
    hashOf,
    hashFor(seatId: string): string {
      return hashOf(tokenFor(seatId))
    },
    verify(seatId: string, token: string): boolean {
      return constantTimeStringEqual(normalizeTicketToken(token), tokenFor(seatId))
    },
  }
}
