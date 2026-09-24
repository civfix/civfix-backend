/**
 * Test helper that replicates the SHARED CLIENT's query serialization (shared/src/client/client.ts
 * buildQuery) byte-for-byte, so route tests exercise the EXACT query string the web + mobile clients
 * produce. This is the regression guard for a query-encoding mismatch: if the backend ever drifts
 * from what the client sends, these tests fail.
 *
 * Mirrors buildQuery:
 *   - undefined / null   -> skipped
 *   - Array              -> repeated params (append each element)
 *   - object             -> a single JSON.stringify'd param (bbox / near)
 *   - scalar             -> a single param
 */
export function clientQuery(query: Record<string, unknown>): string {
  const sp = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const v of value) sp.append(key, String(v))
    } else if (typeof value === "object") {
      sp.append(key, JSON.stringify(value))
    } else {
      sp.append(key, String(value))
    }
  }
  const qs = sp.toString()
  return qs ? `?${qs}` : ""
}
