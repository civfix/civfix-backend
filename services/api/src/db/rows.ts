// A query whose row the surrounding code already guarantees (INSERT ... RETURNING, an upsert, a read of a
// row a conflict or lock just proved exists) coming back empty is a broken invariant rather than a client error, so it
// fails loudly with the query named.
export function requireRow<T>(rows: readonly T[], query: string): T {
  const row = rows[0]
  if (row === undefined) throw new Error(`${query}: expected a row, got none`)
  return row
}
