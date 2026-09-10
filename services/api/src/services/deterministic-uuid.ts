import { createHash } from "node:crypto"

const UUID_V5_SHAPE = /^(.{8})(.{4})(.{4})(.{4})(.{12})$/u

export function deterministicUuid(parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join(" ")).digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  const groups = UUID_V5_SHAPE.exec(hex)
  if (groups === null) throw new Error("deterministic uuid: unexpected digest shape")
  return groups[1] + "-" + groups[2] + "-" + groups[3] + "-" + groups[4] + "-" + groups[5]
}
