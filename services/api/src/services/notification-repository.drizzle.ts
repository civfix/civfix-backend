/**
 * Postgres-backed NotificationRepository (the production implementation of the notifications seam).
 *
 * ALL notification/prefs/push-token access flows through here so the notification service stays infra-free
 * and unit-testable with an in-memory repo. Written against the raw postgres-js tag (`Sql`) to match the
 * rest of the backend.
 *
 * FEED (listNotifications): keyset pagination on (created_at DESC, id DESC) with a `${iso}|${id}` cursor.
 * The id tiebreak keeps a total order when timestamps tie; `|` cannot appear in an ISO timestamp or a
 * UUID, so the split is unambiguous.
 *
 * READ-STATE (markRead): a single UPDATE setting read_at=now() WHERE user_id = $user AND id = ANY($ids)
 * AND read_at IS NULL. The user_id predicate is what prevents marking someone else's notifications read;
 * the read_at IS NULL guard keeps an already-read row's timestamp stable.
 *
 * PREFS: getPrefs/createDefaultPrefs/upsertPrefs operate on notification_prefs (PK user_id). The defaults
 * are all-true booleans + null quiet hours. upsertPrefs builds an ON CONFLICT DO UPDATE that only touches
 * the columns present in the patch, so a partial update leaves the rest intact. quietHours null clears both
 * time columns; an object sets both.
 *
 * PUSH TOKENS (upsertPushToken): OWNERSHIP-SCOPED re-registration (P1-3). ON CONFLICT (platform, token)
 * DO UPDATE re-points the row + clears revoked_at ONLY when the caller already owns the row OR presents
 * the same non-null device_id; a token owned by a different user with no device proof is left untouched
 * (returned as "conflict"), so a known raw token cannot be used to hijack another user's device.
 */

import type { Sql } from "../db/client.js"
import type {
  NewNotificationArgs,
  NotificationPrefsPatch,
  NotificationPrefsRecord,
  NotificationRecord,
  NotificationRepository,
  PushTokenUpsertOutcome,
} from "./notification-service.js"
import { DEFAULT_PREFS } from "./notification-service.js"
import type { NotificationType, PushPlatform } from "@civfix/shared"

/** Shape of a notification row as selected back. */
interface NotificationRowSelect {
  id: string
  user_id: string
  type: NotificationType
  title: string
  body: string | null
  link: string | null
  read_at: Date | null
  created_at: Date
}

/** Shape of a prefs row as selected back (time columns come back as strings). */
interface PrefsRowSelect {
  push: boolean
  cleanup_chat: boolean
  report_updates: boolean
  follows: boolean
  quiet_start: string | null
  quiet_end: string | null
}

/** Project a selected notification row into the structural NotificationRecord. */
function toRecord(r: NotificationRowSelect): NotificationRecord {
  return {
    id: r.id,
    userId: r.user_id,
    type: r.type,
    title: r.title,
    body: r.body,
    link: r.link,
    readAt: r.read_at,
    createdAt: r.created_at,
  }
}

/** Project a selected prefs row into the structural NotificationPrefsRecord. */
function toPrefsRecord(r: PrefsRowSelect): NotificationPrefsRecord {
  return {
    push: r.push,
    cleanupChat: r.cleanup_chat,
    reportUpdates: r.report_updates,
    follows: r.follows,
    quietStart: r.quiet_start,
    quietEnd: r.quiet_end,
  }
}

export function makeDrizzleNotificationRepository(sql: Sql): NotificationRepository {
  return {
    async insertNotification(args: NewNotificationArgs): Promise<NotificationRecord> {
      const rows = await sql<NotificationRowSelect[]>`
        INSERT INTO notifications (user_id, type, title, body, link)
        VALUES (${args.userId}, ${args.type}, ${args.title}, ${args.body}, ${args.link})
        RETURNING id, user_id, type, title, body, link, read_at, created_at
      `
      // The insert always returns exactly one row.
      return toRecord(rows[0]!)
    },

    async listNotifications(
      userId: string,
      cursor: string | null,
      limit: number,
    ): Promise<{ records: NotificationRecord[]; nextCursor: string | null }> {
      const parsed = parseTimeCursor(cursor)
      const cursorFilter =
        parsed !== null
          ? sql`AND (created_at, id) < (${parsed.at}, ${parsed.id}::uuid)`
          : sql``
      const rows = await sql<NotificationRowSelect[]>`
        SELECT id, user_id, type, title, body, link, read_at, created_at
        FROM notifications
        WHERE user_id = ${userId}
          ${cursorFilter}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}
      `
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const last = page[page.length - 1]
      const nextCursor =
        hasMore && last ? `${last.created_at.toISOString()}|${last.id}` : null
      return { records: page.map(toRecord), nextCursor }
    },

    async markRead(userId: string, ids: string[]): Promise<void> {
      if (ids.length === 0) return
      // Only the user's own, still-unread rows are touched. `id = ANY(...)` takes the uuid[] directly.
      await sql`
        UPDATE notifications
        SET read_at = now()
        WHERE user_id = ${userId}
          AND id = ANY(${ids}::uuid[])
          AND read_at IS NULL
      `
    },

    async findPrefs(userId: string): Promise<NotificationPrefsRecord | null> {
      const rows = await sql<PrefsRowSelect[]>`
        SELECT push, cleanup_chat, report_updates, follows, quiet_start, quiet_end
        FROM notification_prefs
        WHERE user_id = ${userId}
        LIMIT 1
      `
      return rows[0] ? toPrefsRecord(rows[0]) : null
    },

    async createDefaultPrefs(userId: string): Promise<NotificationPrefsRecord> {
      // Insert the defaults; if a concurrent request already created the row, DO NOTHING and read it back.
      const rows = await sql<PrefsRowSelect[]>`
        INSERT INTO notification_prefs (user_id, push, cleanup_chat, report_updates, follows)
        VALUES (
          ${userId},
          ${DEFAULT_PREFS.push},
          ${DEFAULT_PREFS.cleanupChat},
          ${DEFAULT_PREFS.reportUpdates},
          ${DEFAULT_PREFS.follows}
        )
        ON CONFLICT (user_id) DO NOTHING
        RETURNING push, cleanup_chat, report_updates, follows, quiet_start, quiet_end
      `
      if (rows[0]) return toPrefsRecord(rows[0])
      // Lost the insert race: the row exists, so read it.
      const existing = await sql<PrefsRowSelect[]>`
        SELECT push, cleanup_chat, report_updates, follows, quiet_start, quiet_end
        FROM notification_prefs WHERE user_id = ${userId} LIMIT 1
      `
      return existing[0] ? toPrefsRecord(existing[0]) : DEFAULT_PREFS
    },

    async upsertPrefs(
      userId: string,
      patch: NotificationPrefsPatch,
    ): Promise<NotificationPrefsRecord> {
      // Build the INSERT column/value lists and the DO UPDATE SET list from only the present patch keys, so
      // a partial update leaves the untouched columns at their current values. The INSERT side supplies a
      // full row (defaults for absent booleans, null for absent quiet hours) for the first-time case; the
      // DO UPDATE side only overwrites the patched columns.
      const setFragments: Array<ReturnType<Sql>> = []
      if (patch.push !== undefined) setFragments.push(sql`push = ${patch.push}`)
      if (patch.cleanupChat !== undefined) setFragments.push(sql`cleanup_chat = ${patch.cleanupChat}`)
      if (patch.reportUpdates !== undefined)
        setFragments.push(sql`report_updates = ${patch.reportUpdates}`)
      if (patch.follows !== undefined) setFragments.push(sql`follows = ${patch.follows}`)
      if (patch.quietHours !== undefined) {
        const start = patch.quietHours === null ? null : patch.quietHours.start
        const end = patch.quietHours === null ? null : patch.quietHours.end
        setFragments.push(sql`quiet_start = ${start}::time`)
        setFragments.push(sql`quiet_end = ${end}::time`)
      }

      // Insert-side full row values (used only when the row does not yet exist).
      const insStart =
        patch.quietHours !== undefined && patch.quietHours !== null ? patch.quietHours.start : null
      const insEnd =
        patch.quietHours !== undefined && patch.quietHours !== null ? patch.quietHours.end : null

      // When the patch is empty (no-op), just ensure-and-return the row via the defaults insert path.
      if (setFragments.length === 0) {
        const rows = await sql<PrefsRowSelect[]>`
          INSERT INTO notification_prefs (user_id) VALUES (${userId})
          ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
          RETURNING push, cleanup_chat, report_updates, follows, quiet_start, quiet_end
        `
        return toPrefsRecord(rows[0]!)
      }

      const rows = await sql<PrefsRowSelect[]>`
        INSERT INTO notification_prefs (
          user_id, push, cleanup_chat, report_updates, follows, quiet_start, quiet_end
        ) VALUES (
          ${userId},
          ${patch.push ?? DEFAULT_PREFS.push},
          ${patch.cleanupChat ?? DEFAULT_PREFS.cleanupChat},
          ${patch.reportUpdates ?? DEFAULT_PREFS.reportUpdates},
          ${patch.follows ?? DEFAULT_PREFS.follows},
          ${insStart}::time,
          ${insEnd}::time
        )
        ON CONFLICT (user_id) DO UPDATE SET ${joinSet(sql, setFragments)}
        RETURNING push, cleanup_chat, report_updates, follows, quiet_start, quiet_end
      `
      return toPrefsRecord(rows[0]!)
    },

    async upsertPushToken(args: {
      userId: string
      platform: PushPlatform
      token: string
      deviceId: string | null
    }): Promise<PushTokenUpsertOutcome> {
      // OWNERSHIP-SCOPED re-registration (P1-3). ON CONFLICT (platform, token) DO UPDATE ... WHERE:
      //   - re-point/reactivate only when the conflicting row ALREADY belongs to this user, OR
      //   - the caller presents the SAME non-null device_id as the stored row (a genuine device handoff).
      // Otherwise (a token owned by a DIFFERENT user with no device-ownership proof) the WHERE fails, the
      // UPDATE is skipped, no row is returned, and the existing owner KEEPS the token (no silent steal).
      // A fresh (platform, token) inserts normally. RETURNING tells us which happened.
      const rows = await sql<{ id: string }[]>`
        INSERT INTO push_tokens (user_id, platform, token, device_id)
        VALUES (${args.userId}, ${args.platform}, ${args.token}, ${args.deviceId})
        ON CONFLICT (platform, token) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          device_id = EXCLUDED.device_id,
          revoked_at = NULL
        WHERE push_tokens.user_id = EXCLUDED.user_id
           OR (EXCLUDED.device_id IS NOT NULL AND push_tokens.device_id = EXCLUDED.device_id)
        RETURNING id
      `
      // 1 row -> inserted or owner/same-device update. 0 rows -> a foreign-owned conflict left untouched.
      return rows.length > 0 ? "stored" : "conflict"
    },
  }
}

/**
 * Join SET assignment fragments with commas into one fragment for the DO UPDATE clause. Callers guarantee
 * a non-empty array (the empty-patch case is handled before this is reached).
 */
function joinSet(sql: Sql, fragments: Array<ReturnType<Sql>>): ReturnType<Sql> {
  let acc = fragments[0]!
  for (let i = 1; i < fragments.length; i++) {
    acc = sql`${acc}, ${fragments[i]!}`
  }
  return acc
}

/** Parse an `${iso}|${id}` time cursor; null when absent/malformed. */
function parseTimeCursor(cursor: string | null): { at: Date; id: string } | null {
  if (cursor === null) return null
  const idx = cursor.indexOf("|")
  if (idx <= 0) return null
  const iso = cursor.slice(0, idx)
  const id = cursor.slice(idx + 1)
  const at = new Date(iso)
  if (Number.isNaN(at.getTime()) || id.length === 0) return null
  return { at, id }
}
