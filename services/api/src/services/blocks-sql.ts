import type { Sql, SqlFragment } from "../db/client.js"

export function blockedPairExpr(
  sql: Sql,
  viewerId: string | null,
  subjectIdColumn: SqlFragment,
): SqlFragment {
  if (viewerId === null) return sql`FALSE`
  return sql`EXISTS (
    SELECT 1 FROM user_blocks b
    WHERE ${subjectIdColumn} <> ${viewerId}
      AND ((b.blocker_id = ${viewerId} AND b.blocked_id = ${subjectIdColumn})
        OR (b.blocker_id = ${subjectIdColumn} AND b.blocked_id = ${viewerId}))
  )`
}
