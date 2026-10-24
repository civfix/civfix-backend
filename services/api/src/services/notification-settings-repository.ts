import type { NotificationCategory, NotificationCategorySetting } from "@civfix/contract"

/** A stored `notification_settings` row. A category with no row is at its contract default. */
export interface NotificationSettingRecord extends NotificationCategorySetting {
  userId: string
  category: NotificationCategory
}

export type NotificationSettingsPatch = Partial<
  Record<NotificationCategory, Partial<NotificationCategorySetting>>
>

export interface NotificationSettingsRepository {
  getSettings(userId: string): Promise<NotificationSettingRecord[]>

  getSettingsMany(userIds: string[]): Promise<NotificationSettingRecord[]>

  /**
   * Writes every category the patch names. A new row takes the fields the patch leaves out from
   * NOTIFICATION_CATEGORY_DEFAULTS; an existing row keeps them.
   */
  upsertSettings(userId: string, patch: NotificationSettingsPatch): Promise<void>

  /** Unchecks Email for one category of a live account; false when the account is erased or missing. */
  disableEmail(userId: string, category: NotificationCategory): Promise<boolean>
}
