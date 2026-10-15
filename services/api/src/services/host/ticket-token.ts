import { createHmac } from "node:crypto"
import { constantTimeStringEqual } from "../../auth/crypto.js"
import { sha256HexSync } from "../../lib/hash.js"

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

const BITS_PER_BYTE = 8

const BASE32_BITS = 5

const BASE32_MASK = BASE32_ALPHABET.length - 1

const TICKET_TOKEN_BYTES = 16

export const TICKET_TOKEN_LENGTH = 26

const TOKEN_SEPARATORS = /[\s-]+/gu

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
    buffer = (buffer << BITS_PER_BYTE) | byte
    bits += BITS_PER_BYTE
    while (bits >= BASE32_BITS) {
      bits -= BASE32_BITS
      out += BASE32_ALPHABET[(buffer >> bits) & BASE32_MASK]
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (BASE32_BITS - bits)) & BASE32_MASK]
  return out
}

export function normalizeTicketToken(raw: string): string {
  return raw.replace(TOKEN_SEPARATORS, "").toUpperCase()
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
    return sha256HexSync(normalizeTicketToken(token))
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
