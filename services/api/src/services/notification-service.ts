
import type {
  ListNotificationsResponse,
  NotificationDTO,
  NotificationPrefsDTO,
  NotificationType,
  PaginationQuery,
  PushPlatform,
  QuietHours,
  RegisterPushTokenRequest,
  UpdateNotificationPrefsRequest,
} from "@civfix/shared"
import type { PushPayload, PushSender, UserChannel } from "@civfix/shared/interfaces"
import type { FastifyBaseLogger } from "fastify"
import type { PersonView, SocialNotifier } from "./social-service.js"
import {
  isWithinQuietHours,
  toNotificationDTO,
  toPrefsDTO,
  typeAllowedByPrefs,
} from "./notification-helpers.js"
import { renderMessage, type MessageKey, type MessageVars } from "../i18n/renderMessage.js"
import { DEFAULT_LOCALE } from "../i18n/locales.js"

export {
  DEFAULT_PREFS,
  FEED_HIDDEN_NOTIFICATION_TYPES,
  isFeedVisibleType,
  isWithinQuietHours,
  parseTimeOfDayMinutes,
  toNotificationDTO,
  toPrefsDTO,
  typeAllowedByPrefs,
} from "./notification-helpers.js"

export const NOTIFICATIONS_DEFAULT_LIMIT = 20

const MARK_READ_MAX_IDS = 50

export interface NotificationRecord {
  id: string
  userId: string
  type: NotificationType
  title: string
  body: string | null
  link: string | null
  readAt: Date | null
  createdAt: Date
}

export interface NewNotificationArgs {
  userId: string
  type: NotificationType
  title: string
  body: string | null
  link: string | null
}

export interface NotificationPrefsRecord {
  push: boolean
  cleanupChat: boolean
  reportUpdates: boolean
  follows: boolean
  mentions: boolean
  quietStart: string | null
  quietEnd: string | null
}

export interface NotificationPrefsPatch {
  push?: boolean
  cleanupChat?: boolean
  reportUpdates?: boolean
  follows?: boolean
  mentions?: boolean
  quietHours?: QuietHours | null
}

export interface NotificationRepository {
  insertNotification(args: NewNotificationArgs): Promise<NotificationRecord>

  listNotifications(
    userId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: NotificationRecord[]; nextCursor: string | null }>

  markRead(userId: string, ids: string[]): Promise<void>

  clearByTypeAndLink(userId: string, type: NotificationType, link: string): Promise<void>

  findPrefs(userId: string): Promise<NotificationPrefsRecord | null>

  createDefaultPrefs(userId: string): Promise<NotificationPrefsRecord>

  upsertPrefs(userId: string, patch: NotificationPrefsPatch): Promise<NotificationPrefsRecord>

  upsertPushToken(args: {
    userId: string
    platform: PushPlatform
    token: string
    deviceId: string | null
  }): Promise<PushTokenUpsertOutcome>

  deletePushTokensForUser(userId: string): Promise<void>

  findUserLocale(userId: string): Promise<string | null>
}

export type PushTokenUpsertOutcome = "stored" | "conflict"

export interface CreateNotificationInput {
  type: NotificationType
  title?: string
  body?: string
  titleKey?: MessageKey
  bodyKey?: MessageKey
  vars?: MessageVars
  link?: string
}

export interface NotificationServiceDeps {
  repo: NotificationRepository
  pushSender: PushSender
  userChannel?: UserChannel
  logger?: Pick<FastifyBaseLogger, "warn" | "error">
  now?: () => Date
}

export interface NotificationService extends SocialNotifier {
  listNotifications(userId: string, pagination: PaginationQuery): Promise<ListNotificationsResponse>
  markRead(userId: string, ids: string[]): Promise<{ ok: true }>
  getPrefs(userId: string): Promise<NotificationPrefsDTO>
  updatePrefs(userId: string, patch: UpdateNotificationPrefsRequest): Promise<NotificationPrefsDTO>
  registerPushToken(userId: string, req: RegisterPushTokenRequest): Promise<{ ok: true }>
  createNotification(userId: string, input: CreateNotificationInput): Promise<NotificationDTO>
  clearByTypeAndLink(userId: string, type: NotificationType, link: string): Promise<void>
}

export function makeNotificationService(deps: NotificationServiceDeps): NotificationService {
  const now = deps.now ?? (() => new Date())

  async function resolvePrefs(userId: string): Promise<NotificationPrefsRecord> {
    const existing = await deps.repo.findPrefs(userId)
    if (existing) return existing
    return deps.repo.createDefaultPrefs(userId)
  }

  async function maybeSendPush(userId: string, record: NotificationRecord): Promise<void> {
    try {
      const prefs = await resolvePrefs(userId)
      if (!typeAllowedByPrefs(record.type, prefs)) return
      if (isWithinQuietHours(now(), prefs.quietStart, prefs.quietEnd)) return

      const payload: PushPayload = {
        title: record.title,
        ...(record.body !== null ? { body: record.body } : {}),
        ...(record.link !== null ? { link: record.link } : {}),
        data: { type: record.type, notificationId: record.id },
      }
      await deps.pushSender.send(userId, payload)
    } catch (err) {
      deps.logger?.warn(
        { err, userId, notificationId: record.id, type: record.type },
        "inline push send failed (suppressed)",
      )
    }
  }

  async function maybeSignalNotification(userId: string): Promise<void> {
    if (!deps.userChannel) return
    try {
      await deps.userChannel.publishToUser(userId, { topic: "notifications" })
    } catch (err) {
      deps.logger?.warn({ err, userId }, "notification signal publish failed (suppressed)")
    }
  }

  async function localeFor(userId: string, input: CreateNotificationInput): Promise<string> {
    if (input.titleKey === undefined && input.bodyKey === undefined) return DEFAULT_LOCALE
    try {
      return (await deps.repo.findUserLocale(userId)) ?? DEFAULT_LOCALE
    } catch (err) {
      deps.logger?.warn({ err, userId }, "notification locale lookup failed; falling back to en")
      return DEFAULT_LOCALE
    }
  }

  async function doCreateNotification(
    userId: string,
    input: CreateNotificationInput,
  ): Promise<NotificationDTO> {
    const locale = await localeFor(userId, input)
    const title =
      input.titleKey !== undefined
        ? renderMessage(locale, input.titleKey, input.vars)
        : (input.title ?? "")
    const body =
      input.bodyKey !== undefined
        ? renderMessage(locale, input.bodyKey, input.vars)
        : (input.body ?? null)
    const record = await deps.repo.insertNotification({
      userId,
      type: input.type,
      title,
      body,
      link: input.link ?? null,
    })
    await maybeSendPush(userId, record)
    void maybeSignalNotification(userId).catch((err: unknown) => {
      deps.logger?.error({ err, userId }, "notification signal dispatch failed (suppressed)")
    })
    return toNotificationDTO(record)
  }

  return {
    async listNotifications(
      userId: string,
      pagination: PaginationQuery,
    ): Promise<ListNotificationsResponse> {
      const { records, nextCursor } = await deps.repo.listNotifications(
        userId,
        pagination.cursor ?? null,
        pagination.limit ?? NOTIFICATIONS_DEFAULT_LIMIT,
      )
      return { items: records.map(toNotificationDTO), nextCursor }
    },

    async markRead(userId: string, ids: string[]): Promise<{ ok: true }> {
      if (ids.length > 0) await deps.repo.markRead(userId, ids.slice(0, MARK_READ_MAX_IDS))
      return { ok: true }
    },

    async getPrefs(userId: string): Promise<NotificationPrefsDTO> {
      return toPrefsDTO(await resolvePrefs(userId))
    },

    async updatePrefs(
      userId: string,
      patch: UpdateNotificationPrefsRequest,
    ): Promise<NotificationPrefsDTO> {
      await resolvePrefs(userId)
      const repoPatch: NotificationPrefsPatch = {
        ...(patch.push !== undefined ? { push: patch.push } : {}),
        ...(patch.cleanupChat !== undefined ? { cleanupChat: patch.cleanupChat } : {}),
        ...(patch.reportUpdates !== undefined ? { reportUpdates: patch.reportUpdates } : {}),
        ...(patch.follows !== undefined ? { follows: patch.follows } : {}),
        ...(patch.mentions !== undefined ? { mentions: patch.mentions } : {}),
        ...("quietHours" in patch ? { quietHours: patch.quietHours ?? null } : {}),
      }
      return toPrefsDTO(await deps.repo.upsertPrefs(userId, repoPatch))
    },

    async registerPushToken(
      userId: string,
      req: RegisterPushTokenRequest,
    ): Promise<{ ok: true }> {
      const outcome = await deps.repo.upsertPushToken({
        userId,
        platform: req.platform,
        token: req.token,
        deviceId: req.deviceId ?? null,
      })
      if (outcome === "conflict") {
        deps.logger?.warn(
          { userId, platform: req.platform, hasDeviceId: req.deviceId !== undefined },
          "push token re-registration refused: token owned by another user (no device-ownership proof)",
        )
        return { ok: true }
      }
      try {
        await deps.pushSender.registerToken(userId, req.token, req.platform, req.deviceId)
      } catch (err) {
        deps.logger?.warn({ err, userId, platform: req.platform }, "pushSender.registerToken failed")
      }
      return { ok: true }
    },

    createNotification(userId: string, input: CreateNotificationInput): Promise<NotificationDTO> {
      return doCreateNotification(userId, input)
    },

    async clearByTypeAndLink(
      userId: string,
      type: NotificationType,
      link: string,
    ): Promise<void> {
      await deps.repo.clearByTypeAndLink(userId, type, link)
      await maybeSignalNotification(userId)
    },

    async onNewFollower(args: { followeeId: string; follower: PersonView }): Promise<void> {
      const name =
        args.follower.displayName.trim() !== ""
          ? args.follower.displayName
          : args.follower.handle
            ? `@${args.follower.handle}`
            : "Someone"
      await doCreateNotification(args.followeeId, {
        type: "new_follower",
        titleKey: "notification.follower.title",
        bodyKey: "notification.follower.body",
        vars: { name },
        link: `/people/${args.follower.id}`,
      })
    },
  }
}
