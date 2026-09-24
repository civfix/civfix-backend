import { createHash } from "node:crypto"

const UUID_BYTES = 16
const UUID_V5_SHAPE = /^(.{8})(.{4})(.{4})(.{4})(.{12})$/u

/** RFC 4122 section 4.1.3: the high nibble of byte 6 carries the version. */
const VERSION_BYTE = 6
const VERSION_KEEP_MASK = 0x0f
const VERSION_5_BITS = 0x50
/** RFC 4122 section 4.1.1: the top two bits of byte 8 carry the variant. */
const VARIANT_BYTE = 8
const VARIANT_KEEP_MASK = 0x3f
const RFC4122_VARIANT_BITS = 0x80

export function deterministicUuid(parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join(" ")).digest()
  const bytes = Buffer.from(digest.subarray(0, UUID_BYTES))
  bytes[VERSION_BYTE] = ((bytes[VERSION_BYTE] as number) & VERSION_KEEP_MASK) | VERSION_5_BITS
  bytes[VARIANT_BYTE] = ((bytes[VARIANT_BYTE] as number) & VARIANT_KEEP_MASK) | RFC4122_VARIANT_BITS
  const hex = bytes.toString("hex")
  const groups = UUID_V5_SHAPE.exec(hex)
  if (groups === null) throw new Error("deterministic uuid: unexpected digest shape")
  return groups[1] + "-" + groups[2] + "-" + groups[3] + "-" + groups[4] + "-" + groups[5]
}
