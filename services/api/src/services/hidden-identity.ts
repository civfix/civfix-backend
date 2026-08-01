import { avatarGradient } from "@civfix/shared"
import type { Sql } from "../db/client.js"

export const HIDDEN_USER_LABEL = "Community member"

type AvatarPair = ReturnType<typeof avatarGradient>

export interface HiddenIdentity {
  name: string
  avatar: AvatarPair
}

export function hiddenIdentity(userId: string): HiddenIdentity {
  return { name: HIDDEN_USER_LABEL, avatar: avatarGradient(userId) }
}

type SqlFragment = ReturnType<Sql>

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
