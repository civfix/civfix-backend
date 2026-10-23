import type { Sql } from "../db/client.js"
import type { NotificationSettingsRepository } from "./notification-settings-repository.js"

export function makeDrizzleNotificationSettingsRepository(
  _sql: Sql,
): NotificationSettingsRepository {
  return {
    getSettings() {
      throw new Error("not implemented")
    },
    getSettingsMany() {
      throw new Error("not implemented")
    },
    upsertSettings() {
      throw new Error("not implemented")
    },
  }
}
