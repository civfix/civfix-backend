import { NOTIFICATION_CATEGORY_DEFAULTS } from "@civfix/contract"
import type { NotificationCategory } from "@civfix/contract"
import type { Sql } from "../db/client.js"
import type {
  NotificationSettingRecord,
  NotificationSettingsPatch,
  NotificationSettingsRepository,
} from "./notification-settings-repository.js"

interface SettingRowSelect {
  user_id: string
  category: NotificationCategory
  enabled: boolean
  push: boolean
  email: boolean
}

function toRecord(r: SettingRowSelect): NotificationSettingRecord {
  return {
    userId: r.user_id,
    category: r.category,
    enabled: r.enabled,
    push: r.push,
    email: r.email,
  }
}

export function makeDrizzleNotificationSettingsRepository(
  sql: Sql,
): NotificationSettingsRepository {
  return {
    async getSettings(userId: string): Promise<NotificationSettingRecord[]> {
      const rows = await sql<SettingRowSelect[]>`
        SELECT user_id, category, enabled, push, email
        FROM notification_settings
        WHERE user_id = ${userId}
      `
      return rows.map(toRecord)
    },

    async getSettingsMany(userIds: string[]): Promise<NotificationSettingRecord[]> {
      if (userIds.length === 0) return []
      const rows = await sql<SettingRowSelect[]>`
        SELECT user_id, category, enabled, push, email
        FROM notification_settings
        WHERE user_id = ANY(${userIds}::uuid[])
      `
      return rows.map(toRecord)
    },

    async upsertSettings(userId: string, patch: NotificationSettingsPatch): Promise<void> {
      const rows = (
        Object.entries(patch) as [
          NotificationCategory,
          NotificationSettingsPatch[NotificationCategory],
        ][]
      ).flatMap(([category, fields]) => {
        if (!fields) return []
        const defaults = NOTIFICATION_CATEGORY_DEFAULTS[category]
        return [
          {
            category,
            enabled: fields.enabled ?? null,
            push: fields.push ?? null,
            email: fields.email ?? null,
            new_enabled: fields.enabled ?? defaults.enabled,
            new_push: fields.push ?? defaults.push,
            new_email: fields.email ?? defaults.email,
          },
        ]
      })
      if (rows.length === 0) return

      // Each input row carries the patch's fields (null where it leaves one out) and the row a new
      // category gets (those fields filled from the contract default). DO UPDATE sees only EXCLUDED, the
      // filled row, so an existing row reads the patch's own fields back from the input and keeps any
      // the patch left out. jsonb_to_recordset turns a JSON null into SQL NULL.
      await sql`
        WITH input AS (
          SELECT *
          FROM jsonb_to_recordset(${sql.json(rows)}) AS i (
            category text, enabled boolean, push boolean, email boolean,
            new_enabled boolean, new_push boolean, new_email boolean
          )
        )
        INSERT INTO notification_settings AS s (user_id, category, enabled, push, email)
        SELECT ${userId}, i.category, i.new_enabled, i.new_push, i.new_email
        FROM input i
        ON CONFLICT (user_id, category) DO UPDATE SET
          (enabled, push, email) = (
            SELECT COALESCE(i.enabled, s.enabled), COALESCE(i.push, s.push), COALESCE(i.email, s.email)
            FROM input i
            WHERE i.category = EXCLUDED.category
          ),
          updated_at = now()
      `
    },

    // FOR SHARE waits for an erasure holding the users row and then re-checks deleted_at, so erasure's
    // DELETE of the settings can't be followed by this INSERT; if this commits first, erasure deletes the row.
    async disableEmail(userId: string, category: NotificationCategory): Promise<boolean> {
      const defaults = NOTIFICATION_CATEGORY_DEFAULTS[category]
      const rows = await sql<{ user_id: string }[]>`
        INSERT INTO notification_settings AS s (user_id, category, enabled, push, email)
        SELECT u.id, ${category}, ${defaults.enabled}, ${defaults.push}, false
        FROM users u
        WHERE u.id = ${userId} AND u.deleted_at IS NULL
        FOR SHARE OF u
        ON CONFLICT (user_id, category) DO UPDATE SET email = false, updated_at = now()
        RETURNING s.user_id
      `
      return rows.length > 0
    },
  }
}
