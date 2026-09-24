import type { Sql } from "../db/client.js"
import {
  keysetInstant,
  keysetPredicate,
  paginateKeyset,
  parseKeysetCursor,
} from "../db/cursor-helpers.js"
import type {
  NewNotificationArgs,
  NotificationPrefsPatch,
  NotificationPrefsRecord,
  NotificationRecord,
  NotificationRepository,
  PushTokenUpsertOutcome,
} from "./notification-service.js"
import { DEFAULT_PREFS, FEED_HIDDEN_NOTIFICATION_TYPES } from "./notification-service.js"
import { AppError } from "@civfix/shared"
import type { NotificationType, PushPlatform } from "@civfix/shared"

const QUIET_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/

export const MAX_ACTIVE_PUSH_TOKENS_PER_USER = 10

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

interface PrefsRowSelect {
  push: boolean
  cleanup_chat: boolean
  report_updates: boolean
  follows: boolean
  mentions: boolean
  post_interactions: boolean
  host_broadcasts: boolean
  quiet_start: string | null
  quiet_end: string | null
  tz: string | null
}

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

function toPrefsRecord(r: PrefsRowSelect): NotificationPrefsRecord {
  return {
    push: r.push,
    cleanupChat: r.cleanup_chat,
    reportUpdates: r.report_updates,
    follows: r.follows,
    mentions: r.mentions,
    postInteractions: r.post_interactions,
    hostBroadcasts: r.host_broadcasts,
    quietStart: r.quiet_start,
    quietEnd: r.quiet_end,
    tz: r.tz,
  }
}

export interface RefreshUnreadArgs {
  userId: string
  type: NotificationType
  link: string
  title: string
  body: string | null
  since: Date
}

function refreshUnreadWith(exec: Sql, args: RefreshUnreadArgs): Promise<NotificationRecord | null> {
  return exec<NotificationRowSelect[]>`
    UPDATE notifications
    SET title = ${args.title}, body = ${args.body}
    WHERE id = (
      SELECT id FROM notifications
      WHERE user_id = ${args.userId}
        AND type = ${args.type}
        AND link = ${args.link}
        AND read_at IS NULL
        AND created_at > ${args.since}
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
    )
    RETURNING id, user_id, type, title, body, link, read_at, created_at
  `.then((rows) => (rows[0] ? toRecord(rows[0]) : null))
}

export function makeDrizzleNotificationRepository(sql: Sql): NotificationRepository {
  return {
    async insertNotification(args: NewNotificationArgs): Promise<NotificationRecord> {
      const rows = await sql<NotificationRowSelect[]>`
        INSERT INTO notifications (user_id, type, title, body, link)
        VALUES (${args.userId}, ${args.type}, ${args.title}, ${args.body}, ${args.link})
        RETURNING id, user_id, type, title, body, link, read_at, created_at
      `
      return toRecord(rows[0]!)
    },

    async listNotifications(
      userId: string,
      cursor: string | null,
      limit: number,
    ): Promise<{ records: NotificationRecord[]; nextCursor: string | null }> {
      const parsed = parseKeysetCursor(cursor)
      const cursorFilter =
        parsed !== null ? sql`AND ${keysetPredicate(sql, sql`created_at`, sql`id`, parsed)}` : sql``
      const rows = await sql<(NotificationRowSelect & { cursor_at: string | null })[]>`
        SELECT id, user_id, type, title, body, link, read_at, created_at,
               ${keysetInstant(sql, sql`created_at`)} AS cursor_at
        FROM notifications
        WHERE user_id = ${userId}
          AND type <> ALL(${[...FEED_HIDDEN_NOTIFICATION_TYPES]}::text[])
          ${cursorFilter}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}
      `
      const { items, nextCursor } = paginateKeyset(rows, limit, (r) => ({
        atText: r.cursor_at,
        id: r.id,
      }))
      return { records: items.map(toRecord), nextCursor }
    },

    async markRead(userId: string, ids: string[]): Promise<void> {
      if (ids.length === 0) return
      await sql`
        UPDATE notifications
        SET read_at = now()
        WHERE user_id = ${userId}
          AND id = ANY(${ids}::uuid[])
          AND read_at IS NULL
      `
    },

    async clearByTypeAndLink(userId: string, type: NotificationType, link: string): Promise<void> {
      await sql`
        UPDATE notifications
        SET read_at = now()
        WHERE user_id = ${userId}
          AND type = ${type}
          AND link = ${link}
          AND read_at IS NULL
      `
    },

    async findPrefs(userId: string): Promise<NotificationPrefsRecord | null> {
      const rows = await sql<PrefsRowSelect[]>`
        SELECT push, cleanup_chat, report_updates, follows, mentions, post_interactions, host_broadcasts, quiet_start, quiet_end, tz
        FROM notification_prefs
        WHERE user_id = ${userId}
        LIMIT 1
      `
      return rows[0] ? toPrefsRecord(rows[0]) : null
    },

    async findPrefsMany(userIds: string[]): Promise<Map<string, NotificationPrefsRecord>> {
      const out = new Map<string, NotificationPrefsRecord>()
      if (userIds.length === 0) return out
      const rows = await sql<(PrefsRowSelect & { user_id: string })[]>`
        SELECT user_id, push, cleanup_chat, report_updates, follows, mentions, post_interactions, host_broadcasts, quiet_start, quiet_end, tz
        FROM notification_prefs
        WHERE user_id = ANY(${userIds}::uuid[])
      `
      for (const row of rows) out.set(row.user_id, toPrefsRecord(row))
      return out
    },

    async createDefaultPrefs(userId: string): Promise<NotificationPrefsRecord> {
      const rows = await sql<PrefsRowSelect[]>`
        INSERT INTO notification_prefs (
          user_id, push, cleanup_chat, report_updates, follows, mentions, post_interactions,
          host_broadcasts, quiet_start, quiet_end
        )
        VALUES (
          ${userId},
          ${DEFAULT_PREFS.push},
          ${DEFAULT_PREFS.cleanupChat},
          ${DEFAULT_PREFS.reportUpdates},
          ${DEFAULT_PREFS.follows},
          ${DEFAULT_PREFS.mentions},
          ${DEFAULT_PREFS.postInteractions},
          ${DEFAULT_PREFS.hostBroadcasts},
          ${DEFAULT_PREFS.quietStart}::time,
          ${DEFAULT_PREFS.quietEnd}::time
        )
        ON CONFLICT (user_id) DO NOTHING
        RETURNING push, cleanup_chat, report_updates, follows, mentions, post_interactions, host_broadcasts, quiet_start, quiet_end, tz
      `
      if (rows[0]) return toPrefsRecord(rows[0])
      const existing = await sql<PrefsRowSelect[]>`
        SELECT push, cleanup_chat, report_updates, follows, mentions, post_interactions, host_broadcasts, quiet_start, quiet_end, tz
        FROM notification_prefs WHERE user_id = ${userId} LIMIT 1
      `
      return existing[0] ? toPrefsRecord(existing[0]) : DEFAULT_PREFS
    },

    async upsertPrefs(
      userId: string,
      patch: NotificationPrefsPatch,
    ): Promise<NotificationPrefsRecord> {
      if (isEmptyPatch(patch)) {
        const inserted = await sql<PrefsRowSelect[]>`
          INSERT INTO notification_prefs (user_id) VALUES (${userId})
          ON CONFLICT (user_id) DO NOTHING
          RETURNING push, cleanup_chat, report_updates, follows, mentions, post_interactions, host_broadcasts, quiet_start, quiet_end, tz
        `
        if (inserted[0]) return toPrefsRecord(inserted[0])
        const existing = await sql<PrefsRowSelect[]>`
          SELECT push, cleanup_chat, report_updates, follows, mentions, post_interactions, host_broadcasts, quiet_start, quiet_end, tz
          FROM notification_prefs WHERE user_id = ${userId} LIMIT 1
        `
        return existing[0] ? toPrefsRecord(existing[0]) : DEFAULT_PREFS
      }

      const setFragments: Array<ReturnType<Sql>> = []
      if (patch.push !== undefined) setFragments.push(sql`push = ${patch.push}`)
      if (patch.cleanupChat !== undefined)
        setFragments.push(sql`cleanup_chat = ${patch.cleanupChat}`)
      if (patch.reportUpdates !== undefined)
        setFragments.push(sql`report_updates = ${patch.reportUpdates}`)
      if (patch.follows !== undefined) setFragments.push(sql`follows = ${patch.follows}`)
      if (patch.mentions !== undefined) setFragments.push(sql`mentions = ${patch.mentions}`)
      if (patch.postInteractions !== undefined)
        setFragments.push(sql`post_interactions = ${patch.postInteractions}`)
      if (patch.hostBroadcasts !== undefined)
        setFragments.push(sql`host_broadcasts = ${patch.hostBroadcasts}`)
      if (patch.quietHours !== undefined) {
        const start = patch.quietHours === null ? null : patch.quietHours.start
        const end = patch.quietHours === null ? null : patch.quietHours.end
        if (
          (start !== null && !QUIET_TIME_RE.test(start)) ||
          (end !== null && !QUIET_TIME_RE.test(end))
        ) {
          throw AppError.validation({ quietHours: "invalid" }, "quietHours must be HH:MM (24-hour)")
        }
        const tz = patch.quietHours === null ? null : (patch.quietHours.tz ?? null)
        setFragments.push(sql`quiet_start = ${start}::time`)
        setFragments.push(sql`quiet_end = ${end}::time`)
        setFragments.push(sql`tz = ${tz}`)
      }

      const insStart =
        patch.quietHours !== undefined && patch.quietHours !== null ? patch.quietHours.start : null
      const insEnd =
        patch.quietHours !== undefined && patch.quietHours !== null ? patch.quietHours.end : null
      const insTz =
        patch.quietHours !== undefined && patch.quietHours !== null
          ? (patch.quietHours.tz ?? null)
          : null

      const rows = await sql<PrefsRowSelect[]>`
        INSERT INTO notification_prefs (
          user_id, push, cleanup_chat, report_updates, follows, mentions, post_interactions, host_broadcasts, quiet_start, quiet_end, tz
        ) VALUES (
          ${userId},
          ${patch.push ?? DEFAULT_PREFS.push},
          ${patch.cleanupChat ?? DEFAULT_PREFS.cleanupChat},
          ${patch.reportUpdates ?? DEFAULT_PREFS.reportUpdates},
          ${patch.follows ?? DEFAULT_PREFS.follows},
          ${patch.mentions ?? DEFAULT_PREFS.mentions},
          ${patch.postInteractions ?? DEFAULT_PREFS.postInteractions},
          ${patch.hostBroadcasts ?? DEFAULT_PREFS.hostBroadcasts},
          ${insStart}::time,
          ${insEnd}::time,
          ${insTz}
        )
        ON CONFLICT (user_id) DO UPDATE SET ${joinSet(sql, setFragments)}
        RETURNING push, cleanup_chat, report_updates, follows, mentions, post_interactions, host_broadcasts, quiet_start, quiet_end, tz
      `
      return toPrefsRecord(rows[0]!)
    },

    async upsertPushToken(args: {
      userId: string
      platform: PushPlatform
      token: string
      deviceId: string | null
    }): Promise<PushTokenUpsertOutcome> {
      const rows = await sql<{ id: string }[]>`
        INSERT INTO push_tokens (user_id, platform, token, device_id)
        VALUES (${args.userId}, ${args.platform}, ${args.token}, ${args.deviceId})
        ON CONFLICT (platform, token) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          device_id = EXCLUDED.device_id,
          revoked_at = NULL,
          created_at = now()
        WHERE push_tokens.user_id = EXCLUDED.user_id OR push_tokens.revoked_at IS NOT NULL
        RETURNING id
      `
      if (rows.length === 0) return "conflict"
      await sql`
        UPDATE push_tokens
        SET revoked_at = now()
        WHERE user_id = ${args.userId}
          AND revoked_at IS NULL
          AND id NOT IN (
            SELECT id FROM push_tokens
            WHERE user_id = ${args.userId} AND revoked_at IS NULL
            ORDER BY created_at DESC, id DESC
            LIMIT ${MAX_ACTIVE_PUSH_TOKENS_PER_USER}
          )
      `
      return "stored"
    },

    async revokeToken(userId: string, platform: PushPlatform, token: string): Promise<void> {
      await sql`
        UPDATE push_tokens
        SET revoked_at = now()
        WHERE user_id = ${userId}
          AND platform = ${platform}
          AND token = ${token}
          AND revoked_at IS NULL
      `
    },

    async deletePushTokensForUser(userId: string): Promise<void> {
      await sql`DELETE FROM push_tokens WHERE user_id = ${userId}`
    },

    async insertUnlessRecentDuplicate(
      args: NewNotificationArgs & { since: Date },
    ): Promise<{ record: NotificationRecord; deduped: boolean }> {
      return sql.begin(async (tx) => {
        // A plain look-then-insert lets two concurrent writers both miss and both insert; the key
        // lock makes the second wait for the first's commit and then find its row.
        await tx`
          SELECT pg_advisory_xact_lock(
            hashtext('notification_dedupe:' || ${args.userId} || ':' || ${args.type} || ':' || COALESCE(${args.link}::text, ''))
          )
        `
        const existing = await tx<NotificationRowSelect[]>`
          SELECT id, user_id, type, title, body, link, read_at, created_at
          FROM notifications
          WHERE user_id = ${args.userId}
            AND type = ${args.type}
            AND link IS NOT DISTINCT FROM ${args.link}
            AND body IS NOT DISTINCT FROM ${args.body}
            AND created_at > ${args.since}
          ORDER BY created_at DESC
          LIMIT 1
        `
        if (existing[0]) return { record: toRecord(existing[0]), deduped: true }
        const rows = await tx<NotificationRowSelect[]>`
          INSERT INTO notifications (user_id, type, title, body, link)
          VALUES (${args.userId}, ${args.type}, ${args.title}, ${args.body}, ${args.link})
          RETURNING id, user_id, type, title, body, link, read_at, created_at
        `
        return { record: toRecord(rows[0]!), deduped: false }
      }) as Promise<{ record: NotificationRecord; deduped: boolean }>
    },

    refreshUnreadNotification(args: RefreshUnreadArgs): Promise<NotificationRecord | null> {
      return refreshUnreadWith(sql, args)
    },

    async upsertCoalescedNotification(
      args: RefreshUnreadArgs,
    ): Promise<{ record: NotificationRecord; coalesced: boolean }> {
      return sql.begin(async (tx) => {
        // FOR UPDATE in the refresh locks nothing when no unread row exists yet, so two concurrent
        // fan-outs would each insert one; this key lock makes the second see the first's row.
        await tx`
          SELECT pg_advisory_xact_lock(
            hashtext('notification_coalesce:' || ${args.userId} || ':' || ${args.type} || ':' || ${args.link})
          )
        `
        const refreshed = await refreshUnreadWith(tx as unknown as Sql, args)
        if (refreshed) return { record: refreshed, coalesced: true }
        const rows = await tx<NotificationRowSelect[]>`
          INSERT INTO notifications (user_id, type, title, body, link)
          VALUES (${args.userId}, ${args.type}, ${args.title}, ${args.body}, ${args.link})
          RETURNING id, user_id, type, title, body, link, read_at, created_at
        `
        return { record: toRecord(rows[0]!), coalesced: false }
      }) as Promise<{ record: NotificationRecord; coalesced: boolean }>
    },

    async deleteAllNotificationsForUser(userId: string): Promise<void> {
      await sql`DELETE FROM notifications WHERE user_id = ${userId}`
    },

    async findUserLocaleMany(userIds: string[]): Promise<Map<string, string>> {
      const out = new Map<string, string>()
      if (userIds.length === 0) return out
      const rows = await sql<{ id: string; locale: string | null }[]>`
        SELECT id, locale FROM users WHERE id = ANY(${userIds}::uuid[])
      `
      for (const row of rows) {
        if (row.locale !== null) out.set(row.id, row.locale)
      }
      return out
    },

    async findUserLocale(userId: string): Promise<string | null> {
      const rows = await sql<{ locale: string }[]>`
        SELECT locale FROM users WHERE id = ${userId} LIMIT 1
      `
      return rows[0]?.locale ?? null
    },
  }
}

function isEmptyPatch(patch: NotificationPrefsPatch): boolean {
  return (
    patch.push === undefined &&
    patch.cleanupChat === undefined &&
    patch.reportUpdates === undefined &&
    patch.follows === undefined &&
    patch.mentions === undefined &&
    patch.postInteractions === undefined &&
    patch.hostBroadcasts === undefined &&
    patch.quietHours === undefined
  )
}

function joinSet(sql: Sql, fragments: Array<ReturnType<Sql>>): ReturnType<Sql> {
  return fragments.reduce((acc, frag, i) => (i === 0 ? frag : sql`${acc}, ${frag}`))
}
