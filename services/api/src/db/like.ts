/**
 * LIKE/ILIKE escaping for operator search terms. Unescaped, `%` and `_` act as wildcards (and `\` as the
 * escape): a term can broaden a match arbitrarily and defeat the gin_trgm_ops indexes
 * (0014_search_trgm.sql), since a leading-wildcard `%%%` term forces an unindexed full scan, a cheap DoS
 * lever for any operator.
 *
 * Always pair the escaped value with `ESCAPE '\\'` in the SQL. PostgreSQL defaults the LIKE escape to
 * backslash, but stating it keeps the query independent of that default.
 */

export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

export function likeContains(term: string): string {
  return "%" + escapeLike(term) + "%"
}

export function likePrefix(term: string): string {
  return escapeLike(term) + "%"
}
