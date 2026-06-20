/**
 * Discussion @city-mention parsing + jurisdiction-handle derivation.
 *
 * PURE, DB-free, network-free helpers so the mention detection and the handle slug are unit-testable in
 * isolation (no Postgres, no Docker). The discussion service composes these with the jurisdiction read to
 * decide whether a message @mentions its OWN report's jurisdiction (and should therefore be forwarded).
 *
 * Two concerns, kept separate:
 *   - parseCityMention(body, cityHandle): does the message body reference "@<handle>" (case-insensitive,
 *     word-boundary) for the given handle? Returns the matched handle (preserving the body's casing of the
 *     handle text after the "@") or null. A null/empty cityHandle never matches.
 *   - jurisdictionHandle(name): derive a stable @handle slug from a jurisdiction name, used by the backfill
 *     CLI and resolvable on the fly at read time when the jurisdictions.handle column is still NULL.
 */

/**
 * Derive a stable, lowercase @handle slug from a jurisdiction name. PURE + deterministic.
 *
 * Rules (kept deliberately simple so it is predictable + collision-resistant-enough for a backfill):
 *   - lowercase
 *   - drop a leading "city of " / "town of " / "village of " / "county of " noise prefix
 *   - strip a trailing " city" / " town" / " county" descriptor
 *   - replace any run of non-alphanumeric characters with a single underscore
 *   - trim leading/trailing underscores
 * Returns null when nothing usable survives (e.g. an all-punctuation name), so a caller can treat the
 * handle as "unset" rather than emit an empty token.
 *
 * Examples: "City of San Francisco" -> "san_francisco"; "Los Angeles County" -> "los_angeles";
 * "St. Paul" -> "st_paul"; "Washington, D.C." -> "washington_d_c".
 */
export function jurisdictionHandle(name: string | null | undefined): string | null {
  if (name === null || name === undefined) return null
  let s = name.toLowerCase().trim()
  if (s === "") return null
  // Drop a common "<kind> of " administrative prefix.
  s = s.replace(/^(city|town|village|county|borough|township|municipality)\s+of\s+/i, "")
  // Strip a trailing administrative descriptor word (e.g. "... county", "... city").
  s = s.replace(/\s+(city|town|village|county|borough|township)$/i, "")
  // Collapse any non-alphanumeric run to a single underscore.
  s = s.replace(/[^a-z0-9]+/g, "_")
  // Trim underscores from the ends.
  s = s.replace(/^_+|_+$/g, "")
  return s === "" ? null : s
}

/**
 * Word-boundary-ish characters that may precede/follow an "@handle" token. We treat anything that is NOT a
 * handle character (alphanumeric or underscore) as a boundary, so "@sf" matches in "hey @sf please fix" and
 * "(@sf)" but NOT inside "email@sf" (the "@" is preceded by a word char) or "@sfo" (trailing word char).
 */
const HANDLE_CHAR = /[a-z0-9_]/i

/**
 * Does `body` @mention `cityHandle` (case-insensitive, word-boundary)? Returns the matched handle text as
 * it appeared in the body (the substring after "@", same length as cityHandle) or null when absent.
 *
 * PURE: no DB, no network. A null/empty/whitespace cityHandle never matches. Matching is anchored so that
 * "@<handle>" is preceded by a non-handle char (or start of string) and followed by a non-handle char (or
 * end of string), preventing partial matches ("@sf" must not match "@sfo" or "user@sf.gov" local-parts).
 */
/**
 * Extract every distinct @handle token from a free-text body, for USER @-mentions (distinct from the
 * single-handle parseCityMention, which targets one known jurisdiction handle). PURE: no DB, no network.
 *
 * Uses the SAME handle character rules as parseCityMention (HANDLE_CHAR = [a-z0-9_], word-boundary): a token
 * is an "@" that is preceded by a boundary (start-of-string or a non-handle char) followed by one or more
 * handle chars. So "@jane" matches in "hi @jane and (@bob)!" but the "@" inside "user@host" (preceded by a
 * word char) does NOT start a token. The leading "@" is stripped; the returned handles preserve the body's
 * casing (handles are matched case-insensitively downstream by the DB citext column, so casing is cosmetic).
 *
 * De-duplicated CASE-INSENSITIVELY, preserving first-seen order, so "@Jane ... @jane" yields a single
 * "Jane". Returns [] when the body contains no @handle token. The caller resolves these to real users
 * (resolveHandles) and combines them with any explicit mentionedUserIds.
 */
export function parseUserMentions(body: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "@") continue
    // Boundary before the "@": start of string, or a non-handle char (so "user@x" is not a mention).
    const before = i > 0 ? body[i - 1] : undefined
    if (before !== undefined && HANDLE_CHAR.test(before)) continue
    // Consume the run of handle chars after the "@".
    let j = i + 1
    while (j < body.length && HANDLE_CHAR.test(body[j]!)) j++
    if (j === i + 1) continue // a bare "@" with no handle chars is not a mention.
    const handle = body.slice(i + 1, j)
    const key = handle.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(handle)
    }
    // Advance past the consumed handle (the loop's i++ moves one more).
    i = j - 1
  }
  return out
}

export function parseCityMention(body: string, cityHandle: string | null | undefined): string | null {
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
    // Char immediately BEFORE the "@" must be a boundary (or the "@" is at the start).
    const before = at > 0 ? lowerBody[at - 1] : undefined
    // Char immediately AFTER the handle must be a boundary (or the handle ends the string).
    const afterIdx = at + token.length
    const after = afterIdx < lowerBody.length ? lowerBody[afterIdx] : undefined
    const boundaryBefore = before === undefined || !HANDLE_CHAR.test(before)
    const boundaryAfter = after === undefined || !HANDLE_CHAR.test(after)
    if (boundaryBefore && boundaryAfter) {
      // Return the handle as it appeared in the ORIGINAL body (after the "@"), preserving its casing.
      return body.slice(at + 1, afterIdx)
    }
    from = at + 1
  }
}
