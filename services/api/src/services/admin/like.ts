/**
 * Shared LIKE/ILIKE escaping for operator search filters.
 *
 * Operator `q` search terms flow into `... ILIKE '%' || term || '%'` patterns. Without escaping, the
 * LIKE metacharacters `%` and `_` (and the escape char `\`) in a term are interpreted as wildcards.
 * That lets a term broaden a match arbitrarily and, more importantly, defeats the gin_trgm_ops indexes
 * (0014_search_trgm.sql) — a leading-wildcard `%%%` term forces an unindexed full scan, i.e. a cheap
 * CPU/DoS lever for any authenticated operator. Escaping makes the term match LITERALLY.
 *
 * Always pair the escaped value with `ESCAPE '\\'` in the SQL (PostgreSQL defaults the LIKE escape to
 * backslash, but stating it is explicit and future-proof). Mirrors the long-standing helper in
 * social-repository.drizzle.ts; centralized here so every admin repo shares one definition.
 */

/** Escape %, _ and \ in a term so they are treated literally inside a LIKE/ILIKE pattern. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** Build a literal "contains" pattern: %<escaped term>%. Use with `ESCAPE '\\'` in the query. */
export function likeContains(term: string): string {
  return "%" + escapeLike(term) + "%"
}
