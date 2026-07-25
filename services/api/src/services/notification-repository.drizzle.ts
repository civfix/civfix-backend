
import type { Sql } from "../db/client.js"
import { paginate, parseTimeCursor } from "../db/cursor-helpers.js"
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
  quiet_start: string | null
  quiet_end: string | null
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
          AND type <> ALL(${[...FEED_HIDDEN_NOTIFICATION_TYPES]}::text[])
          ${cursorFilter}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}
      `
      const { items, nextCursor } = paginate(rows, limit, (r) => ({ at: r.created_at, id: r.id }))
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
        SELECT push, cleanup_chat, report_updates, follows, mentions, post_interactions, quiet_start, quiet_end
        FROM notification_prefs
        WHERE user_id = ${userId}
        LIMIT 1
      `
      return rows[0] ? toPrefsRecord(rows[0]) : null
    },

    async createDefaultPrefs(userId: string): Promise<NotificationPrefsRecord> {
      // EVERY pref column is written from DEFAULT_PREFS, exactly like upsertPrefs' insert branch. This
      // used to name only push/cleanup_chat/report_updates/follows and leave mentions,
      // post_interactions and quiet_* to their DB column defaults — so the two row-minting paths agreed
      // only as long as those defaults happened to match DEFAULT_PREFS. DEFAULT_PREFS is the one source.
      const rows = await sql<PrefsRowSelect[]>`
        INSERT INTO notification_prefs (
          user_id, push, cleanup_chat, report_updates, follows, mentions, post_interactions,
          quiet_start, quiet_end
        )
        VALUES (
          ${userId},
          ${DEFAULT_PREFS.push},
          ${DEFAULT_PREFS.cleanupChat},
          ${DEFAULT_PREFS.reportUpdates},
          ${DEFAULT_PREFS.follows},
          ${DEFAULT_PREFS.mentions},
          ${DEFAULT_PREFS.postInteractions},
          ${DEFAULT_PREFS.quietStart}::time,
          ${DEFAULT_PREFS.quietEnd}::time
        )
        ON CONFLICT (user_id) DO NOTHING
        RETURNING push, cleanup_chat, report_updates, follows, mentions, post_interactions, quiet_start, quiet_end
      `
      if (rows[0]) return toPrefsRecord(rows[0])
      const existing = await sql<PrefsRowSelect[]>`
        SELECT push, cleanup_chat, report_updates, follows, mentions, post_interactions, quiet_start, quiet_end
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
          RETURNING push, cleanup_chat, report_updates, follows, mentions, post_interactions, quiet_start, quiet_end
        `
        if (inserted[0]) return toPrefsRecord(inserted[0])
        const existing = await sql<PrefsRowSelect[]>`
          SELECT push, cleanup_chat, report_updates, follows, mentions, post_interactions, quiet_start, quiet_end
          FROM notification_prefs WHERE user_id = ${userId} LIMIT 1
        `
        return existing[0] ? toPrefsRecord(existing[0]) : DEFAULT_PREFS
      }

      const setFragments: Array<ReturnType<Sql>> = []
      if (patch.push !== undefined) setFragments.push(sql`push = ${patch.push}`)
      if (patch.cleanupChat !== undefined) setFragments.push(sql`cleanup_chat = ${patch.cleanupChat}`)
      if (patch.reportUpdates !== undefined)
        setFragments.push(sql`report_updates = ${patch.reportUpdates}`)
      if (patch.follows !== undefined) setFragments.push(sql`follows = ${patch.follows}`)
      if (patch.mentions !== undefined) setFragments.push(sql`mentions = ${patch.mentions}`)
      if (patch.postInteractions !== undefined)
        setFragments.push(sql`post_interactions = ${patch.postInteractions}`)
      if (patch.quietHours !== undefined) {
        const start = patch.quietHours === null ? null : patch.quietHours.start
        const end = patch.quietHours === null ? null : patch.quietHours.end
        if (
          (start !== null && !QUIET_TIME_RE.test(start)) ||
          (end !== null && !QUIET_TIME_RE.test(end))
        ) {
          throw AppError.validation({ quietHours: "invalid" }, "quietHours must be HH:MM (24-hour)")
        }
        setFragments.push(sql`quiet_start = ${start}::time`)
        setFragments.push(sql`quiet_end = ${end}::time`)
      }

      const insStart =
        patch.quietHours !== undefined && patch.quietHours !== null ? patch.quietHours.start : null
      const insEnd =
        patch.quietHours !== undefined && patch.quietHours !== null ? patch.quietHours.end : null

      const rows = await sql<PrefsRowSelect[]>`
        INSERT INTO notification_prefs (
          user_id, push, cleanup_chat, report_updates, follows, mentions, post_interactions, quiet_start, quiet_end
        ) VALUES (
          ${userId},
          ${patch.push ?? DEFAULT_PREFS.push},
          ${patch.cleanupChat ?? DEFAULT_PREFS.cleanupChat},
          ${patch.reportUpdates ?? DEFAULT_PREFS.reportUpdates},
          ${patch.follows ?? DEFAULT_PREFS.follows},
          ${patch.mentions ?? DEFAULT_PREFS.mentions},
          ${patch.postInteractions ?? DEFAULT_PREFS.postInteractions},
          ${insStart}::time,
          ${insEnd}::time
        )
        ON CONFLICT (user_id) DO UPDATE SET ${joinSet(sql, setFragments)}
        RETURNING push, cleanup_chat, report_updates, follows, mentions, post_interactions, quiet_start, quiet_end
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
          revoked_at = NULL
        WHERE push_tokens.user_id = EXCLUDED.user_id
           OR (EXCLUDED.device_id IS NOT NULL AND push_tokens.device_id = EXCLUDED.device_id)
        RETURNING id
      `
      return rows.length > 0 ? "stored" : "conflict"
    },

    async revokeDeviceTokensForOtherUsers(args: {
      userId: string
      token: string
      platform: PushPlatform
      deviceId: string | null
    }): Promise<number> {
      // H12. The old query was `WHERE device_id = $1 AND user_id <> $2` — a caller-supplied string
      // revoking every other account's token that carried it. One harvested device-id list was a
      // fleet-wide push blackout, and the "device_id is the device's own secret" claim in the old
      // comment was never verified by anything.
      //
      // The revoke is now anchored ONLY to something the caller provably holds: the push token itself,
      // which they just presented and which is the address push is actually delivered to. The
      // device_id-driven branch is GONE — no cross-account write is authorized by a self-declared
      // string any more. In practice the upsert above already reassigns the (platform, token) row when
      // the guard allows it, so this usually matches zero rows; it stays as the explicit, correct scope
      // so a future change to the upsert cannot silently reintroduce a wider revoke.
      //
      // COST, stated plainly: a PREVIOUS account's token on a shared device is no longer force-revoked
      // when the token value has rotated. Those tokens are pruned by delivery feedback instead (an
      // Expo/APNs DeviceNotRegistered receipt) and by that account's own re-registration. Restoring an
      // eager device-scoped revoke requires a real possession proof — a silent data push carrying a
      // server nonce that the client echoes back over an authenticated call — which is the tracked
      // follow-up. `deviceId` is retained on the row for support/debugging only; it authorizes nothing.
      const rows = await sql<{ id: string }[]>`
        UPDATE push_tokens
        SET revoked_at = now()
        WHERE user_id <> ${args.userId}
          AND revoked_at IS NULL
          AND platform = ${args.platform}
          AND token = ${args.token}
        RETURNING id
      `
      return rows.length
    },

    async deletePushTokensForUser(userId: string): Promise<void> {
      await sql`DELETE FROM push_tokens WHERE user_id = ${userId}`
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
    patch.quietHours === undefined
  )
}

function joinSet(sql: Sql, fragments: Array<ReturnType<Sql>>): ReturnType<Sql> {
  return fragments.reduce((acc, frag, i) => (i === 0 ? frag : sql`${acc}, ${frag}`))
}
