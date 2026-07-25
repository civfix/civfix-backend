/**
 * ONE IPv6 "::"-expansion primitive. Two call sites needed it with OPPOSITE strictness — the per-IP rate
 * limiter deliberately tolerates garbage (a malformed address must still land in SOME bucket rather than
 * bypass the limiter), while the push-endpoint SSRF guard must reject anything it cannot parse exactly —
 * so this splits the mechanical part (find the zero-run, insert the implied hextets) from the policy part.
 *
 * It therefore validates NOTHING: it reports what it found (`runs`, `fill`) and lets each caller decide
 * what is acceptable. A strict caller asserts `runs <= 1`, `fill >= 1` for a compressed address, exactly 8
 * hextets, and its own per-hextet character check; a lenient one just reads `hextets`.
 */

export interface Ipv6Expansion {
  /** Hextets with any "::" zero-run expanded to explicit "0"s. NOT validated and NOT normalized. */
  hextets: string[]
  /** Number of "::" separators in the input. A valid address has at most one. */
  runs: number
  /**
   * Zero hextets inserted for the run: 0 when there was no run, and NEGATIVE when the written hextets
   * already exceed 8 (a malformed address). Never clamped — a caller that cares must check it.
   */
  fill: number
}

/** Expand a (possibly "::"-compressed) IPv6 address into its hextets. Total: never throws, never null. */
export function expandIpv6Hextets(addr: string): Ipv6Expansion {
  const halves = addr.split("::")
  const runs = halves.length - 1
  // With more than one "::" the address is malformed; we still expand using the FIRST two halves so a
  // lenient caller gets a deterministic bucket, and `runs` tells a strict caller to reject.
  const headRaw = halves[0] ?? ""
  const tailRaw = runs === 0 ? undefined : (halves[1] ?? "")
  const head = headRaw === "" ? [] : headRaw.split(":")
  const tail = tailRaw === undefined ? null : tailRaw === "" ? [] : tailRaw.split(":")

  if (tail === null) {
    // No "::": the address is already full (or malformed); take what is there.
    return { hextets: head, runs, fill: 0 }
  }
  const fill = 8 - head.length - tail.length
  return {
    hextets: [...head, ...Array<string>(Math.max(0, fill)).fill("0"), ...tail],
    runs,
    fill,
  }
}
