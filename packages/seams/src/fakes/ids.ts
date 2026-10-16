/**
 * Deterministic UUID-shaped id generator for fakes. Not cryptographically random; it produces
 * valid-looking v4 UUIDs from a seeded counter so test output is stable and dependency-free.
 */
export function makeIdFactory(seed = 1): () => string {
  // 0 is a FIXED POINT of xorshift32 (0 -> 0), so a caller passing seed 0 (or anything that truncates
  // to 0, e.g. 2**32) would otherwise get the same id forever and silently collide every fake row.
  let n = (seed >>> 0) || 1
  return () => {
    // xorshift32 step for a little spread, then format as a v4 UUID.
    n ^= n << 13
    n ^= n >>> 17
    n ^= n << 5
    n >>>= 0
    const hex = (n.toString(16) + "0".repeat(8)).slice(0, 8)
    const a = hex
    const b = hex.slice(0, 4)
    const c = "4" + hex.slice(1, 4)
    const d = ((parseInt(hex[0] ?? "8", 16) & 0x3) | 0x8).toString(16) + hex.slice(1, 4)
    const e = (hex + hex).slice(0, 12)
    return `${a}-${b}-${c}-${d}-${e}`
  }
}
