/**
 * Validates NOTHING, because its two callers need opposite strictness: the per-IP rate limiter must still
 * bucket a malformed address rather than let it bypass the limiter, while the push-endpoint SSRF guard must
 * reject anything it cannot parse exactly. A strict caller asserts `runs <= 1`, `fill >= 1` for a
 * compressed address, exactly 8 hextets, and its own per-hextet check; a lenient one just reads `hextets`.
 */

const IPV6_HEXTET_COUNT = 8

export interface Ipv6Expansion {
  hextets: string[]
  runs: number
  /** NEGATIVE when the written hextets already exceed 8; never clamped, so a strict caller must check. */
  fill: number
}

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
    return { hextets: head, runs, fill: 0 }
  }
  const fill = IPV6_HEXTET_COUNT - head.length - tail.length
  return {
    hextets: [...head, ...Array<string>(Math.max(0, fill)).fill("0"), ...tail],
    runs,
    fill,
  }
}
