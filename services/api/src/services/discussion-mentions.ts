export function jurisdictionHandle(name: string | null | undefined): string | null {
  if (name === null || name === undefined) return null
  let s = name.toLowerCase().trim()
  if (s === "") return null
  s = s.replace(/^(city|town|village|county|borough|township|municipality)\s+of\s+/i, "")
  s = s.replace(/\s+(city|town|village|county|borough|township)$/i, "")
  s = s.replace(/[^a-z0-9]+/g, "_")
  s = s.replace(/^_+|_+$/g, "")
  return s === "" ? null : s
}

export function effectiveJurisdictionHandle(j: {
  handle: string | null
  name: string
}): string | null {
  return j.handle ?? jurisdictionHandle(j.name)
}

const HANDLE_CHAR = /[a-z0-9_]/i

export const MAX_MENTIONS_PER_MESSAGE = 25

export function parseUserMentions(body: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "@") continue
    const before = i > 0 ? body[i - 1] : undefined
    if (before !== undefined && HANDLE_CHAR.test(before)) continue
    let j = i + 1
    while (j < body.length && HANDLE_CHAR.test(body[j]!)) j++
    if (j === i + 1) continue
    const handle = body.slice(i + 1, j)
    const key = handle.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(handle)
      if (out.length >= MAX_MENTIONS_PER_MESSAGE) break
    }
    i = j - 1
  }
  return out
}

export function parseCityMention(
  body: string,
  cityHandle: string | null | undefined,
): string | null {
  if (cityHandle === null || cityHandle === undefined) return null
  const handle = cityHandle.trim()
  if (handle === "") return null
  const lowerBody = body.toLowerCase()
  const lowerHandle = handle.toLowerCase()
  const token = `@${lowerHandle}`
  let from = 0
  for (;;) {
    const at = lowerBody.indexOf(token, from)
    if (at < 0) return null
    const before = at > 0 ? lowerBody[at - 1] : undefined
    const afterIdx = at + token.length
    const after = afterIdx < lowerBody.length ? lowerBody[afterIdx] : undefined
    const boundaryBefore = before === undefined || !HANDLE_CHAR.test(before)
    const boundaryAfter = after === undefined || !HANDLE_CHAR.test(after)
    if (boundaryBefore && boundaryAfter) {
      return body.slice(at + 1, afterIdx)
    }
    from = at + 1
  }
}
