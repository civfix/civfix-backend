import { FakePushSender } from "@civfix/seams"
import { NotificationCategorySchema } from "@civfix/contract"
import type { NotificationCategory, NotificationDTO } from "@civfix/contract"
import {
  makeNotificationService,
  type CreateNotificationInput,
  type NotificationService,
} from "../../src/services/notification-service.js"
import { categoryForType } from "../../src/services/notification-categories.js"
import type { NotificationEmailDeps } from "../../src/services/notification-email.js"
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
export function captureNotifications(
  now: () => Date = () => new Date(),
  opts: { email?: NotificationEmailDeps } = {},
) {
  const repo = new InMemoryNotificationRepository()
  repo.now = now
  const settings = new InMemoryNotificationSettingsRepository()
  settings.now = now
  const push = new FakePushSender()
  const warnings: unknown[][] = []
  const record = (...args: unknown[]) => void warnings.push(args)
  const real = makeNotificationService({
    repo,
    settingsRepo: settings,
    pushSender: push,
    logger: { warn: record, error: record },
    now,
    ...(opts.email !== undefined ? { email: opts.email } : {}),
  })
  const inputs: CapturedInput[] = []
  const created: Promise<NotificationDTO | null>[] = []

  const service: NotificationService = {
    ...real,
    createNotification: (userId, input) => {
      inputs.push({ userIds: [userId], input })
      const result = real.createNotification(userId, input)
      created.push(result)
      return result
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
    created,
    warnings,
    set,
    setAll,
    rows: (userId: string) => repo.notifications.filter((n) => n.userId === userId),
    pushesTo: (userId: string) => push.sent.filter((p) => p.userId === userId),
  }
}

export type NotificationCapture = ReturnType<typeof captureNotifications>

/** The category a captured input is gated by, the rule createNotification applies. */
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
