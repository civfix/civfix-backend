import { createHash } from "node:crypto"

// Sync and node:crypto only: auth/crypto's async sha256Hex goes through oslo, which must not ride into
// the media-worker bundle (it inlines @civfix/api modules but does not install oslo).
export function sha256HexSync(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex")
}
