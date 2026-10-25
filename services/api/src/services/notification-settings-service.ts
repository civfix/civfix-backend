import { NOTIFICATION_CATEGORY_DEFAULTS, NotificationCategorySchema } from "@civfix/contract"
import type {
  NotificationCategory,
  NotificationCategorySetting,
  NotificationSettingsDTO,
  UpdateNotificationSettingsRequest,
} from "@civfix/contract"
import type { UserStore } from "../auth/stores.js"
import type { NotificationSettingsRepository } from "./notification-settings-repository.js"

export type EffectiveNotificationSettings = Record<
  NotificationCategory,
  NotificationCategorySetting
>

type StoredSetting = NotificationCategorySetting & { category: NotificationCategory }

/** Every category at its stored value, or at its contract default when it has no row. */
export function effectiveNotificationSettings(
  rows: readonly StoredSetting[],
): EffectiveNotificationSettings {
  const stored = new Map(rows.map((row) => [row.category, row]))
  return Object.fromEntries(
    NotificationCategorySchema.options.map((category) => {
      const { enabled, push, email } =
        stored.get(category) ?? NOTIFICATION_CATEGORY_DEFAULTS[category]
      return [category, { enabled, push, email }]
    }),
  ) as EffectiveNotificationSettings
}

export interface NotificationSettingsServiceDeps {
  repo: NotificationSettingsRepository
  users: Pick<UserStore, "findById">
}

export interface NotificationSettingsService {
  getSettings(userId: string): Promise<NotificationSettingsDTO>
  updateSettings(
    userId: string,
    req: UpdateNotificationSettingsRequest,
  ): Promise<NotificationSettingsDTO>
}

export function makeNotificationSettingsService(
  deps: NotificationSettingsServiceDeps,
): NotificationSettingsService {
  async function getSettings(userId: string): Promise<NotificationSettingsDTO> {
    const [rows, user] = await Promise.all([
      deps.repo.getSettings(userId),
      deps.users.findById(userId),
    ])
    return {
      categories: effectiveNotificationSettings(rows),
      emailAvailable: user !== null && user.email !== null && user.emailVerified,
    }
  }

  return {
    getSettings,

    async updateSettings(userId, req) {
      await deps.repo.upsertSettings(userId, req.categories)
      return getSettings(userId)
    },
  }
}
