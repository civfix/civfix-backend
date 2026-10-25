import { FakePushSender } from "@civfix/seams"
import { NotificationCategorySchema } from "@civfix/contract"
import type { NotificationCategory } from "@civfix/contract"
import {
  makeNotificationService,
  type CreateNotificationInput,
  type NotificationService,
} from "../../src/services/notification-service.js"
import { categoryForType } from "../../src/services/notification-categories.js"
import type { NotificationSettingRecord } from "../../src/services/notification-settings-repository.js"
import {
  InMemoryNotificationRepository,
  InMemoryNotificationSettingsRepository,
} from "./notifications.js"

export type Setting = [enabled: boolean, push: boolean, email: boolean]

export const OFF: Setting = [false, false, false]

export interface CapturedInput {
  userIds: string[]
  input: CreateNotificationInput
}

/**
 * The real notification service over the in-memory repositories, recording the input of every
 * create call so a test can assert what a send site asked for as well as what was stored.
 */
export function captureNotifications(now: () => Date = () => new Date()) {
  const repo = new InMemoryNotificationRepository()
  repo.now = now
  const settings = new InMemoryNotificationSettingsRepository()
  settings.now = now
  const push = new FakePushSender()
  const real = makeNotificationService({ repo, settingsRepo: settings, pushSender: push, now })
  const inputs: CapturedInput[] = []

  const service: NotificationService = {
    ...real,
    createNotification: (userId, input) => {
      inputs.push({ userIds: [userId], input })
      return real.createNotification(userId, input)
    },
    createNotifications: (userIds, input) => {
      inputs.push({ userIds, input })
      return real.createNotifications(userIds, input)
    },
    createNotificationsReportingFailures: (userIds, input) => {
      inputs.push({ userIds, input })
      return real.createNotificationsReportingFailures(userIds, input)
    },
  }

  async function set(userId: string, category: NotificationCategory, s: Setting): Promise<void> {
    const [enabled, pushOn, email] = s
    await settings.upsertSettings(userId, { [category]: { enabled, push: pushOn, email } })
  }

  async function setAll(userId: string, s: Setting): Promise<void> {
    for (const category of NotificationCategorySchema.options) await set(userId, category, s)
  }

  return {
    repo,
    settings,
    push,
    service,
    inputs,
    set,
    setAll,
    rows: (userId: string) => repo.notifications.filter((n) => n.userId === userId),
    pushesTo: (userId: string) => push.sent.filter((p) => p.userId === userId),
  }
}

export type NotificationCapture = ReturnType<typeof captureNotifications>

/**
 * The category a captured input is gated by, the rule createNotification applies.
 * @public The per-path category tests (GH#224's second slice) read it.
 */
export function categoryOfInput(input: CreateNotificationInput): NotificationCategory | null {
  return input.category ?? categoryForType(input.type)
}

/**
 * Settings in which every account holder has these categories fully on (Push and Email) unless a test
 * stored otherwise, for broadcast tests about the pipeline rather than about settings.
 */
export class AllOnSettingsRepository extends InMemoryNotificationSettingsRepository {
  constructor(private readonly categories: readonly NotificationCategory[]) {
    super()
  }

  override async getSettingsMany(userIds: string[]): Promise<NotificationSettingRecord[]> {
    const stored = await super.getSettingsMany(userIds)
    const has = new Set(stored.map((r) => `${r.userId}:${r.category}`))
    const filled = userIds.flatMap((userId) =>
      this.categories
        .filter((category) => !has.has(`${userId}:${category}`))
        .map((category) => ({ userId, category, enabled: true, push: true, email: true })),
    )
    return [...stored, ...filled]
  }
}
