
import { AppError } from "@civfix/shared"
import type {
  ListNotificationsResponse,
  NotificationDTO,
  NotificationPrefsDTO,
  NotificationType,
  PaginationQuery,
  PushPlatform,
  QuietHours,
  RegisterPushTokenRequest,
  UnregisterPushTokenRequest,
  UpdateNotificationPrefsRequest,
} from "@civfix/shared"
import type { PushPayload, PushSender, UserChannel } from "@civfix/shared/interfaces"
import type { FastifyBaseLogger } from "fastify"
import type { PersonView, SocialNotifier } from "./social-service.js"
import type { PushGateMode } from "./notification-helpers.js"
import {
  DEFAULT_PREFS,
  isWithinQuietHours,
  pushGateAllows,
  toNotificationDTO,
  toPrefsDTO,
} from "./notification-helpers.js"
import { mapWithLimit } from "./media-presign.js"
import { classifyPushToken, isRegistrablePushEndpoint } from "./push-token-policy.js"
import { renderMessage, type MessageKey, type MessageVars } from "../i18n/renderMessage.js"
import { DEFAULT_LOCALE } from "../i18n/locales.js"

export {
  DEFAULT_PREFS,
  FEED_HIDDEN_NOTIFICATION_TYPES,
  isFeedVisibleType,
  isWithinQuietHours,
  parseTimeOfDayMinutes,
  pushGateAllows,
  toNotificationDTO,
  toPrefsDTO,
  typeAllowedByPrefs,
} from "./notification-helpers.js"
export type { PushGateMode } from "./notification-helpers.js"

export const NOTIFICATIONS_DEFAULT_LIMIT = 20

export const NOTIFICATION_DEDUPE_WINDOW_MS = 5 * 60 * 1000

export const BULK_NOTIFY_CONCURRENCY = 8

export const PUSH_FANOUT_BATCH_SIZE = 100

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
  postInteractions: boolean
  hostBroadcasts: boolean
  quietStart: string | null
  quietEnd: string | null
  tz: string | null
}

export interface NotificationPrefsPatch {
  push?: boolean
  cleanupChat?: boolean
  reportUpdates?: boolean
  follows?: boolean
  mentions?: boolean
  postInteractions?: boolean
  hostBroadcasts?: boolean
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

  findRecentDuplicate(args: {
    userId: string
    type: NotificationType
    link: string | null
    body: string | null
    since: Date
  }): Promise<NotificationRecord | null>

  refreshUnreadNotification(args: {
    userId: string
    type: NotificationType
    link: string
    title: string
    body: string | null
    since: Date
  }): Promise<NotificationRecord | null>

  upsertCoalescedNotification(args: {
    userId: string
    type: NotificationType
    link: string
    title: string
    body: string | null
    since: Date
  }): Promise<{ record: NotificationRecord; coalesced: boolean }>

  deleteAllNotificationsForUser(userId: string): Promise<void>

  findPrefs(userId: string): Promise<NotificationPrefsRecord | null>

  findPrefsMany?(userIds: string[]): Promise<Map<string, NotificationPrefsRecord>>

  createDefaultPrefs(userId: string): Promise<NotificationPrefsRecord>

  upsertPrefs(userId: string, patch: NotificationPrefsPatch): Promise<NotificationPrefsRecord>

  upsertPushToken(args: {
    userId: string
    platform: PushPlatform
    token: string
    deviceId: string | null
  }): Promise<PushTokenUpsertOutcome>

  revokeToken(userId: string, platform: PushPlatform, token: string): Promise<void>

  deletePushTokensForUser(userId: string): Promise<void>

  findUserLocale(userId: string): Promise<string | null>

  findUserLocaleMany?(userIds: string[]): Promise<Map<string, string>>
}

export type PushTokenUpsertOutcome = "stored" | "conflict"

export interface CreateNotificationInput {
  type: NotificationType
  title?: string
  body?: string
  titleKey?: MessageKey
  bodyKey?: MessageKey
  vars?: MessageVars
  varKeys?: Record<string, MessageKey>
  link?: string
  dedupeWindowMs?: number
  coalesceWindowMs?: number
  push?: PushGateMode
}

export interface NotificationServiceDeps {
  repo: NotificationRepository
  pushSender: PushSender
  userChannel?: UserChannel
  logger?: Pick<FastifyBaseLogger, "warn" | "error">
  now?: () => Date
  isSafePushEndpoint?: (endpoint: string) => Promise<boolean>
}

export interface PostNotifier {
  onPostLike(a: { recipientId: string; actorName: string; postId: string }): Promise<void>
  onPostRepost(a: { recipientId: string; actorName: string; postId: string }): Promise<void>
  onPostReply(a: { recipientId: string; actorName: string; postId: string }): Promise<void>
  onPostQuote(a: { recipientId: string; actorName: string; postId: string }): Promise<void>
  onPostMention(a: { recipientId: string; actorName: string; postId: string }): Promise<void>
}

export interface NotificationService extends SocialNotifier, PostNotifier {
  listNotifications(userId: string, pagination: PaginationQuery): Promise<ListNotificationsResponse>
  markRead(userId: string, ids: string[]): Promise<{ ok: true }>
  getPrefs(userId: string): Promise<NotificationPrefsDTO>
  updatePrefs(userId: string, patch: UpdateNotificationPrefsRequest): Promise<NotificationPrefsDTO>
  registerPushToken(userId: string, req: RegisterPushTokenRequest): Promise<{ ok: true }>
  unregisterPushToken(userId: string, req: UnregisterPushTokenRequest): Promise<{ ok: true }>
  createNotification(userId: string, input: CreateNotificationInput): Promise<NotificationDTO>
  createNotifications(userIds: string[], input: CreateNotificationInput): Promise<void>
  clearByTypeAndLink(userId: string, type: NotificationType, link: string): Promise<void>
}

interface ResolvedPrefs {
  byUser: Map<string, NotificationPrefsRecord>
  unreadable: Set<string>
}

export function makeNotificationService(deps: NotificationServiceDeps): NotificationService {
  const now = deps.now ?? (() => new Date())
  const isSafeEndpoint = deps.isSafePushEndpoint ?? isRegistrablePushEndpoint

  async function resolvePrefs(userId: string): Promise<NotificationPrefsRecord> {
    const existing = await deps.repo.findPrefs(userId)
    if (existing) return existing
    return deps.repo.createDefaultPrefs(userId)
  }

  async function maybeSendPush(
    userId: string,
    record: NotificationRecord,
    mode: PushGateMode,
  ): Promise<void> {
    if (mode === "never") return
    try {
      const prefs = await resolvePrefs(userId)
      if (!pushGateAllows(record.type, prefs, mode)) return
      if (isWithinQuietHours(now(), prefs.quietStart, prefs.quietEnd, prefs.tz)) return

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

  function needsLocale(input: CreateNotificationInput): boolean {
    return input.titleKey !== undefined || input.bodyKey !== undefined
  }

  function varsIn(locale: string, input: CreateNotificationInput): MessageVars | undefined {
    if (input.varKeys === undefined) return input.vars
    const localized: MessageVars = { ...input.vars }
    for (const [name, key] of Object.entries(input.varKeys)) {
      localized[name] = renderMessage(locale, key)
    }
    return localized
  }

  async function localeFor(
    userId: string,
    input: CreateNotificationInput,
    resolved?: Map<string, string>,
  ): Promise<string> {
    if (!needsLocale(input)) return DEFAULT_LOCALE
    if (resolved !== undefined) return resolved.get(userId) ?? DEFAULT_LOCALE
    try {
      return (await deps.repo.findUserLocale(userId)) ?? DEFAULT_LOCALE
    } catch (err) {
      deps.logger?.warn({ err, userId }, "notification locale lookup failed; falling back to en")
      return DEFAULT_LOCALE
    }
  }

  async function localesForMany(
    userIds: string[],
    input: CreateNotificationInput,
  ): Promise<Map<string, string> | undefined> {
    if (!needsLocale(input)) return new Map()
    const batch = deps.repo.findUserLocaleMany
    if (batch === undefined) return undefined
    try {
      return await batch.call(deps.repo, userIds)
    } catch (err) {
      deps.logger?.warn(
        { err, count: userIds.length },
        "batched locale lookup failed; falling back to en for this fan-out",
      )
      return new Map()
    }
  }

  async function persistNotification(
    userId: string,
    input: CreateNotificationInput,
    resolvedLocales?: Map<string, string>,
  ): Promise<{ record: NotificationRecord; deduped: boolean }> {
    const locale = await localeFor(userId, input, resolvedLocales)
    const vars = varsIn(locale, input)
    const title =
      input.titleKey !== undefined
        ? renderMessage(locale, input.titleKey, vars)
        : (input.title ?? "")
    const body =
      input.bodyKey !== undefined
        ? renderMessage(locale, input.bodyKey, vars)
        : (input.body ?? null)
    const link = input.link ?? null
    if (input.coalesceWindowMs !== undefined && link !== null) {
      try {
        const { record, coalesced } = await deps.repo.upsertCoalescedNotification({
          userId,
          type: input.type,
          link,
          title,
          body,
          since: new Date(now().getTime() - input.coalesceWindowMs),
        })
        return { record, deduped: coalesced }
      } catch (err) {
        deps.logger?.warn(
          { err, userId, type: input.type },
          "notification coalesce upsert failed; creating anyway",
        )
      }
    }
    if (input.dedupeWindowMs !== undefined) {
      try {
        const existing = await deps.repo.findRecentDuplicate({
          userId,
          type: input.type,
          link,
          body,
          since: new Date(now().getTime() - input.dedupeWindowMs),
        })
        if (existing) return { record: existing, deduped: true }
      } catch (err) {
        deps.logger?.warn(
          { err, userId, type: input.type },
          "notification dedupe lookup failed; creating anyway",
        )
      }
    }
    const record = await deps.repo.insertNotification({
      userId,
      type: input.type,
      title,
      body,
      link,
    })
    return { record, deduped: false }
  }

  async function doCreateNotification(
    userId: string,
    input: CreateNotificationInput,
  ): Promise<NotificationDTO> {
    const { record, deduped } = await persistNotification(userId, input)
    if (deduped) return toNotificationDTO(record)
    void maybeSendPush(userId, record, input.push ?? "auto").catch((err: unknown) => {
      deps.logger?.error({ err, userId }, "push dispatch failed (suppressed)")
    })
    void maybeSignalNotification(userId).catch((err: unknown) => {
      deps.logger?.error({ err, userId }, "notification signal dispatch failed (suppressed)")
    })
    return toNotificationDTO(record)
  }

  async function prefsForMany(userIds: string[]): Promise<ResolvedPrefs> {
    if (deps.repo.findPrefsMany) {
      try {
        return { byUser: await deps.repo.findPrefsMany(userIds), unreadable: new Set<string>() }
      } catch (err) {
        deps.logger?.warn(
          { err, count: userIds.length },
          "batched prefs lookup failed; suppressing push for this fan-out",
        )
        return { byUser: new Map(), unreadable: new Set(userIds) }
      }
    }
    const found = await mapWithLimit(userIds, BULK_NOTIFY_CONCURRENCY, async (userId) => {
      try {
        return { prefs: await deps.repo.findPrefs(userId), readable: true }
      } catch (err) {
        deps.logger?.warn({ err, userId }, "prefs lookup failed; suppressing push for this recipient")
        return { prefs: null, readable: false }
      }
    })
    const byUser = new Map<string, NotificationPrefsRecord>()
    const unreadable = new Set<string>()
    userIds.forEach((userId, i) => {
      const outcome = found[i]
      if (!outcome || !outcome.readable) {
        unreadable.add(userId)
        return
      }
      if (outcome.prefs) byUser.set(userId, outcome.prefs)
    })
    return { byUser, unreadable }
  }

  async function sendBatchedPush(
    created: Array<{ userId: string; record: NotificationRecord }>,
    mode: PushGateMode,
  ): Promise<void> {
    if (mode === "never") return
    const { byUser, unreadable } = await prefsForMany(created.map((c) => c.userId))
    const at = now()
    const groups = new Map<string, { payload: PushPayload; userIds: string[] }>()
    for (const { userId, record } of created) {
      if (unreadable.has(userId)) continue
      const prefs = byUser.get(userId) ?? DEFAULT_PREFS
      if (!pushGateAllows(record.type, prefs, mode)) continue
      if (isWithinQuietHours(at, prefs.quietStart, prefs.quietEnd, prefs.tz)) continue
      const key = JSON.stringify([record.title, record.body, record.link])
      const group = groups.get(key)
      if (group) {
        group.userIds.push(userId)
        continue
      }
      groups.set(key, {
        payload: {
          title: record.title,
          ...(record.body !== null ? { body: record.body } : {}),
          ...(record.link !== null ? { link: record.link } : {}),
          data: { type: record.type },
        },
        userIds: [userId],
      })
    }
    for (const group of groups.values()) {
      for (let i = 0; i < group.userIds.length; i += PUSH_FANOUT_BATCH_SIZE) {
        const batch = group.userIds.slice(i, i + PUSH_FANOUT_BATCH_SIZE)
        try {
          await deps.pushSender.sendMany(batch, group.payload)
        } catch (err) {
          deps.logger?.warn({ err, count: batch.length }, "batched push send failed (suppressed)")
        }
      }
    }
  }

  async function signalMany(userIds: string[]): Promise<void> {
    if (!deps.userChannel) return
    try {
      await deps.userChannel.publishToUsers(userIds, { topic: "notifications" })
    } catch (err) {
      deps.logger?.warn({ err, count: userIds.length }, "notification signal publish failed (suppressed)")
    }
  }

  async function doCreateNotifications(
    userIds: string[],
    input: CreateNotificationInput,
  ): Promise<void> {
    const unique = [...new Set(userIds)]
    if (unique.length === 0) return
    const locales = await localesForMany(unique, input)
    const persisted = await mapWithLimit(unique, BULK_NOTIFY_CONCURRENCY, async (userId) => {
      try {
        const { record, deduped } = await persistNotification(userId, input, locales)
        return deduped ? null : { userId, record }
      } catch (err) {
        deps.logger?.warn(
          { err, userId, type: input.type },
          "fan-out notification insert failed (suppressed)",
        )
        return null
      }
    })
    const created = persisted.filter((p): p is { userId: string; record: NotificationRecord } => p !== null)
    if (created.length === 0) return
    void sendBatchedPush(created, input.push ?? "auto").catch((err: unknown) => {
      deps.logger?.error({ err, count: created.length }, "batched push dispatch failed (suppressed)")
    })
    void signalMany(created.map((c) => c.userId))
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
      if (ids.length > 0) await deps.repo.markRead(userId, ids)
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
        ...(patch.postInteractions !== undefined
          ? { postInteractions: patch.postInteractions }
          : {}),
        ...(patch.hostBroadcasts !== undefined ? { hostBroadcasts: patch.hostBroadcasts } : {}),
        ...("quietHours" in patch ? { quietHours: patch.quietHours ?? null } : {}),
      }
      return toPrefsDTO(await deps.repo.upsertPrefs(userId, repoPatch))
    },

    async registerPushToken(
      userId: string,
      req: RegisterPushTokenRequest,
    ): Promise<{ ok: true }> {
      const shape = classifyPushToken(req.platform, req.token)
      if (!shape.ok) {
        throw AppError.validation({ [shape.field]: shape.reason }, "Invalid push token")
      }
      if (shape.kind === "web" && (await isSafeEndpoint(shape.endpoint)) === false) {
        throw AppError.validation(
          { token: "subscription endpoint must be a public https push service" },
          "Invalid push token",
        )
      }
      const outcome = await deps.repo.upsertPushToken({
        userId,
        platform: req.platform,
        token: req.token,
        deviceId: req.deviceId ?? null,
      })
      if (outcome === "conflict") {
        deps.logger?.warn(
          { userId, platform: req.platform, hasDeviceId: req.deviceId !== undefined },
          "push token re-registration refused: token is bound to another account (no possession proof)",
        )
        throw AppError.conflict(
          "This push token is registered to another account. Sign out on the other account or reinstall the app.",
        )
      }
      try {
        await deps.pushSender.registerToken(userId, req.token, req.platform, req.deviceId)
      } catch (err) {
        deps.logger?.warn({ err, userId, platform: req.platform }, "pushSender.registerToken failed")
      }
      return { ok: true }
    },

    async unregisterPushToken(
      userId: string,
      req: UnregisterPushTokenRequest,
    ): Promise<{ ok: true }> {
      await deps.repo.revokeToken(userId, req.platform, req.token)
      return { ok: true }
    },

    createNotification(userId: string, input: CreateNotificationInput): Promise<NotificationDTO> {
      return doCreateNotification(userId, input)
    },

    createNotifications(userIds: string[], input: CreateNotificationInput): Promise<void> {
      return doCreateNotifications(userIds, input)
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
        dedupeWindowMs: NOTIFICATION_DEDUPE_WINDOW_MS,
      })
    },

    async onPostLike(a: { recipientId: string; actorName: string; postId: string }): Promise<void> {
      await doCreateNotification(a.recipientId, {
        type: "post_like",
        titleKey: "notification.post.like.title",
        bodyKey: "notification.post.like.body",
        vars: { name: a.actorName },
        link: `/post/${a.postId}`,
        dedupeWindowMs: NOTIFICATION_DEDUPE_WINDOW_MS,
      })
    },

    async onPostRepost(a: { recipientId: string; actorName: string; postId: string }): Promise<void> {
      await doCreateNotification(a.recipientId, {
        type: "post_repost",
        titleKey: "notification.post.repost.title",
        bodyKey: "notification.post.repost.body",
        vars: { name: a.actorName },
        link: `/post/${a.postId}`,
        dedupeWindowMs: NOTIFICATION_DEDUPE_WINDOW_MS,
      })
    },

    async onPostReply(a: { recipientId: string; actorName: string; postId: string }): Promise<void> {
      await doCreateNotification(a.recipientId, {
        type: "post_reply",
        titleKey: "notification.post.reply.title",
        bodyKey: "notification.post.reply.body",
        vars: { name: a.actorName },
        link: `/post/${a.postId}`,
      })
    },

    async onPostQuote(a: { recipientId: string; actorName: string; postId: string }): Promise<void> {
      await doCreateNotification(a.recipientId, {
        type: "post_quote",
        titleKey: "notification.post.quote.title",
        bodyKey: "notification.post.quote.body",
        vars: { name: a.actorName },
        link: `/post/${a.postId}`,
      })
    },

    async onPostMention(a: {
      recipientId: string
      actorName: string
      postId: string
    }): Promise<void> {
      await doCreateNotification(a.recipientId, {
        type: "post_mention",
        titleKey: "notification.post.mention.title",
        bodyKey: "notification.post.mention.body",
        vars: { name: a.actorName },
        link: `/post/${a.postId}`,
      })
    },
  }
}
