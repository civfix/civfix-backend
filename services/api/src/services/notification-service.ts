import { AppError } from "@civfix/contract"
import type {
  ListNotificationsResponse,
  NotificationCategory,
  NotificationCategorySetting,
  NotificationDTO,
  NotificationPrefsDTO,
  NotificationType,
  PaginationQuery,
  RegisterPushTokenRequest,
  UnregisterPushTokenRequest,
  UpdateNotificationPrefsRequest,
} from "@civfix/contract"
import type { PushItem, PushPayload, PushSender, UserChannel } from "@civfix/seams"
import type { FastifyBaseLogger } from "fastify"
import type { SocialNotifier } from "./social-service.js"
import type { PersonView } from "./social-repository.js"
import type { PushGateMode } from "./notification-helpers.js"
import {
  isWithinQuietHours,
  prefsFromSettings,
  settingsPatchFromPrefs,
  toNotificationDTO,
} from "./notification-helpers.js"
import { categoryForType, categorySettings } from "./notification-categories.js"
import { mapWithLimit } from "../lib/concurrency.js"
import { classifyPushToken, isRegistrablePushEndpoint } from "./push-token-policy.js"
import { renderMessage, type MessageKey, type MessageVars } from "../i18n/renderMessage.js"
import { DEFAULT_LOCALE } from "../i18n/locales.js"
import { actorDisplayName } from "./public-author.js"
import type { NotificationSettingsRepository } from "./notification-settings-repository.js"
import { effectiveNotificationSettings } from "./notification-settings-service.js"
import type {
  NotificationPrefsRecord,
  NotificationRecord,
  NotificationRepository,
} from "./notification-repository.js"

export {
  DEFAULT_PREFS,
  FEED_HIDDEN_NOTIFICATION_TYPES,
  isFeedVisibleType,
  isWithinQuietHours,
  parseTimeOfDayMinutes,
  toPrefsDTO,
  typeAllowedByPrefs,
} from "./notification-helpers.js"
export type { PushGateMode } from "./notification-helpers.js"

const NOTIFICATIONS_DEFAULT_LIMIT = 20

export const NOTIFICATION_DEDUPE_WINDOW_MS = 5 * 60 * 1000

const BULK_NOTIFY_CONCURRENCY = 8

const SETTINGS_READ_BATCH_SIZE = 500

export const PUSH_FANOUT_BATCH_SIZE = 100

const NOTIFICATIONS_TOPIC = "notifications"

const INVALID_PUSH_TOKEN_MESSAGE = "Invalid push token"

function postLink(postId: string): string {
  return `/post/${postId}`
}

function personLink(userId: string): string {
  return `/people/${userId}`
}

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
  /** Gates the notification by this category instead of its type's. */
  category?: NotificationCategory
  email?: "auto" | "never"
  conversationName?: string
}

export interface NotificationServiceDeps {
  repo: NotificationRepository
  settingsRepo: NotificationSettingsRepository
  pushSender: PushSender
  userChannel?: UserChannel
  logger?: Pick<FastifyBaseLogger, "warn" | "error">
  now?: () => Date
  isSafePushEndpoint?: (endpoint: string) => Promise<boolean>
}

export interface PostActivity {
  recipientId: string
  actorName: string
  postId: string
}

export interface PostNotifier {
  onPostLike(a: PostActivity): Promise<void>
  onPostRepost(a: PostActivity): Promise<void>
  onPostReply(a: PostActivity): Promise<void>
  onPostQuote(a: PostActivity): Promise<void>
  onPostMention(a: PostActivity): Promise<void>
}

export interface FanOutNotificationResult {
  /**
   * Recipients whose in-app row was never written. The call resolves even when every write failed,
   * so each caller decides what a failure means: the chat fan-out fails its job on a total failure,
   * and the broadcast pipeline retries exactly these.
   */
  failed: string[]
}

export interface NotificationService extends SocialNotifier, PostNotifier {
  listNotifications(userId: string, pagination: PaginationQuery): Promise<ListNotificationsResponse>
  markRead(userId: string, ids: string[]): Promise<{ ok: true }>
  getPrefs(userId: string): Promise<NotificationPrefsDTO>
  updatePrefs(userId: string, patch: UpdateNotificationPrefsRequest): Promise<NotificationPrefsDTO>
  registerPushToken(userId: string, req: RegisterPushTokenRequest): Promise<{ ok: true }>
  unregisterPushToken(userId: string, req: UnregisterPushTokenRequest): Promise<{ ok: true }>
  /** Resolves `null` when the recipient turned the notification's category Off: nothing was written. */
  createNotification(
    userId: string,
    input: CreateNotificationInput,
  ): Promise<NotificationDTO | null>
  createNotifications(userIds: string[], input: CreateNotificationInput): Promise<void>
  createNotificationsReportingFailures(
    userIds: string[],
    input: CreateNotificationInput,
  ): Promise<FanOutNotificationResult>
  clearByTypeAndLink(userId: string, type: NotificationType, link: string): Promise<void>
}

type FallbackLane = "coalesce" | "dedupe"

type FallbackReporter = (lane: FallbackLane, err: unknown) => void

interface ResolvedPrefs {
  byUser: Map<string, NotificationPrefsRecord>
  unreadable: Set<string>
}

type PostActivityType = "post_like" | "post_repost" | "post_reply" | "post_quote" | "post_mention"

interface PostActivitySpec {
  titleKey: MessageKey
  bodyKey: MessageKey
  deduped: boolean
}

// Likes and reposts can be toggled repeatedly, so they are deduped; a reply, quote or mention is new
// content every time.
const POST_ACTIVITY_SPECS: Record<PostActivityType, PostActivitySpec> = {
  post_like: {
    titleKey: "notification.post.like.title",
    bodyKey: "notification.post.like.body",
    deduped: true,
  },
  post_repost: {
    titleKey: "notification.post.repost.title",
    bodyKey: "notification.post.repost.body",
    deduped: true,
  },
  post_reply: {
    titleKey: "notification.post.reply.title",
    bodyKey: "notification.post.reply.body",
    deduped: false,
  },
  post_quote: {
    titleKey: "notification.post.quote.title",
    bodyKey: "notification.post.quote.body",
    deduped: false,
  },
  post_mention: {
    titleKey: "notification.post.mention.title",
    bodyKey: "notification.post.mention.body",
    deduped: false,
  },
}

/** The recipient's setting for the notification's category; `null` when it is Always on. */
type Gate = NotificationCategorySetting | null

interface Recipient {
  userId: string
  gate: Gate
}

interface CreatedNotification extends Recipient {
  record: NotificationRecord
}

function categoryOf(input: CreateNotificationInput): NotificationCategory | null {
  return input.category ?? categoryForType(input.type)
}

// "always" is the critical-broadcast bypass of the Push checkbox. No mode overrides Off: that is checked
// before the row is written.
function pushAllowed(gate: Gate, mode: PushGateMode): boolean {
  if (mode === "never") return false
  if (mode === "always" || gate === null) return true
  return gate.push
}

function pushItemsFor(
  created: readonly CreatedNotification[],
  { byUser, unreadable }: ResolvedPrefs,
  category: NotificationCategory | null,
  at: Date,
): PushItem[] {
  const items: PushItem[] = []
  for (const { userId, record } of created) {
    if (unreadable.has(userId)) continue
    const prefs = byUser.get(userId)
    if (prefs && isWithinQuietHours(at, prefs.quietStart, prefs.quietEnd, prefs.tz)) continue
    items.push({ userId, payload: pushPayloadOf(record, category) })
  }
  return items
}

function pushPayloadOf(
  record: NotificationRecord,
  category: NotificationCategory | null,
): PushPayload {
  return {
    title: record.title,
    ...(record.body !== null ? { body: record.body } : {}),
    ...(record.link !== null ? { link: record.link } : {}),
    notificationId: record.id,
    type: record.type,
    category,
  }
}

export function makeNotificationService(deps: NotificationServiceDeps): NotificationService {
  const now = deps.now ?? (() => new Date())
  const isSafeEndpoint = deps.isSafePushEndpoint ?? isRegistrablePushEndpoint

  async function getPrefs(userId: string): Promise<NotificationPrefsDTO> {
    const [settings, quiet] = await Promise.all([
      deps.settingsRepo.getSettings(userId),
      deps.repo.findPrefs(userId),
    ])
    return prefsFromSettings(effectiveNotificationSettings(settings), quiet)
  }

  async function maybeSendPush(
    userId: string,
    record: NotificationRecord,
    category: NotificationCategory | null,
  ): Promise<void> {
    try {
      const prefs = await deps.repo.findPrefs(userId)
      if (prefs && isWithinQuietHours(now(), prefs.quietStart, prefs.quietEnd, prefs.tz)) return

      await deps.pushSender.send(userId, pushPayloadOf(record, category))
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
      await deps.userChannel.publishToUser(userId, { topic: NOTIFICATIONS_TOPIC })
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

  function logFallback(
    lane: FallbackLane,
    err: unknown,
    userId: string,
    input: CreateNotificationInput,
  ) {
    deps.logger?.warn(
      { err, userId, type: input.type },
      lane === "coalesce"
        ? "notification coalesce upsert failed; creating anyway"
        : "notification dedupe insert failed; creating anyway",
    )
  }

  async function persistNotification(
    userId: string,
    input: CreateNotificationInput,
    resolvedLocales?: Map<string, string>,
    onFallback: FallbackReporter = (lane, err) => logFallback(lane, err, userId, input),
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
        onFallback("coalesce", err)
      }
    }
    if (input.dedupeWindowMs !== undefined) {
      try {
        return await deps.repo.insertUnlessRecentDuplicate({
          userId,
          type: input.type,
          title,
          body,
          link,
          since: new Date(now().getTime() - input.dedupeWindowMs),
        })
      } catch (err) {
        onFallback("dedupe", err)
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

  async function gateFor(userId: string, category: NotificationCategory | null): Promise<Gate> {
    if (category === null) return null
    return categorySettings(await deps.settingsRepo.getSettings(userId), category)(userId)
  }

  async function doCreateNotification(
    userId: string,
    input: CreateNotificationInput,
  ): Promise<NotificationDTO | null> {
    const category = categoryOf(input)
    const gate = await gateFor(userId, category)
    if (gate !== null && !gate.enabled) return null
    const { record, deduped } = await persistNotification(userId, input)
    if (deduped) return toNotificationDTO(record)
    if (pushAllowed(gate, input.push ?? "auto")) {
      void maybeSendPush(userId, record, category).catch((err: unknown) => {
        deps.logger?.error({ err, userId }, "push dispatch failed (suppressed)")
      })
    }
    void maybeSignalNotification(userId).catch((err: unknown) => {
      deps.logger?.error({ err, userId }, "notification signal dispatch failed (suppressed)")
    })
    return toNotificationDTO(record)
  }

  async function notifyPostActivity(type: PostActivityType, a: PostActivity): Promise<void> {
    const spec = POST_ACTIVITY_SPECS[type]
    await doCreateNotification(a.recipientId, {
      type,
      titleKey: spec.titleKey,
      bodyKey: spec.bodyKey,
      vars: { name: a.actorName },
      link: postLink(a.postId),
      ...(spec.deduped ? { dedupeWindowMs: NOTIFICATION_DEDUPE_WINDOW_MS } : {}),
    })
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
        deps.logger?.warn(
          { err, userId },
          "prefs lookup failed; suppressing push for this recipient",
        )
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
    created: CreatedNotification[],
    category: NotificationCategory | null,
  ): Promise<void> {
    const prefs = await prefsForMany(created.map((c) => c.userId))
    const items = pushItemsFor(created, prefs, category, now())
    for (let i = 0; i < items.length; i += PUSH_FANOUT_BATCH_SIZE) {
      const batch = items.slice(i, i + PUSH_FANOUT_BATCH_SIZE)
      try {
        await deps.pushSender.sendEach(batch)
      } catch (err) {
        deps.logger?.warn({ err, count: batch.length }, "batched push send failed (suppressed)")
      }
    }
  }

  async function signalMany(userIds: string[]): Promise<void> {
    if (!deps.userChannel) return
    try {
      await deps.userChannel.publishToUsers(userIds, { topic: NOTIFICATIONS_TOPIC })
    } catch (err) {
      deps.logger?.warn(
        { err, count: userIds.length },
        "notification signal publish failed (suppressed)",
      )
    }
  }

  function logFanOutFallbacks(
    fallbacks: ReadonlyMap<FallbackLane, { count: number; err: unknown }>,
    input: CreateNotificationInput,
    recipients: number,
  ): void {
    for (const [lane, { count, err }] of fallbacks) {
      deps.logger?.warn(
        { err, type: input.type, lane, fallbacks: count, recipients },
        lane === "coalesce"
          ? "fan-out notification coalesce upsert failed; creating anyway"
          : "fan-out notification dedupe insert failed; creating anyway",
      )
    }
  }

  // A batch whose settings cannot be read is reported as failed rather than written: a row we cannot
  // gate could be one the recipient turned Off.
  async function recipientsOf(
    unique: string[],
    category: NotificationCategory | null,
  ): Promise<{ recipients: Recipient[]; unreadable: string[] }> {
    if (category === null) {
      return { recipients: unique.map((userId) => ({ userId, gate: null })), unreadable: [] }
    }
    const recipients: Recipient[] = []
    const unreadable: string[] = []
    for (let i = 0; i < unique.length; i += SETTINGS_READ_BATCH_SIZE) {
      const batch = unique.slice(i, i + SETTINGS_READ_BATCH_SIZE)
      let settingOf: (userId: string) => NotificationCategorySetting
      try {
        settingOf = categorySettings(await deps.settingsRepo.getSettingsMany(batch), category)
      } catch (err) {
        deps.logger?.warn(
          { err, category, count: batch.length },
          "fan-out settings read failed; reported to the caller",
        )
        unreadable.push(...batch)
        continue
      }
      for (const userId of batch) {
        const gate = settingOf(userId)
        // Off is not a failure, so nothing retries it.
        if (gate.enabled) recipients.push({ userId, gate })
      }
    }
    return { recipients, unreadable }
  }

  async function doCreateNotifications(
    userIds: string[],
    input: CreateNotificationInput,
  ): Promise<FanOutNotificationResult> {
    const unique = [...new Set(userIds)]
    if (unique.length === 0) return { failed: [] }
    const category = categoryOf(input)
    const { recipients, unreadable } = await recipientsOf(unique, category)
    if (recipients.length === 0) return { failed: unreadable }
    const locales = await localesForMany(
      recipients.map((r) => r.userId),
      input,
    )
    const failed: string[] = []
    let firstFailure: unknown
    const fallbacks = new Map<FallbackLane, { count: number; err: unknown }>()
    // One line per fan-out, not per recipient: a store outage across a 2000-member room would
    // otherwise write thousands of warnings for one incident.
    const tallyFallback: FallbackReporter = (lane, err) => {
      const seen = fallbacks.get(lane)
      if (seen) seen.count += 1
      else fallbacks.set(lane, { count: 1, err })
    }
    const persisted = await mapWithLimit(recipients, BULK_NOTIFY_CONCURRENCY, async (recipient) => {
      const { userId } = recipient
      try {
        const { record, deduped } = await persistNotification(userId, input, locales, tallyFallback)
        return deduped ? null : { ...recipient, record }
      } catch (err) {
        if (failed.length === 0) firstFailure = err
        failed.push(userId)
        return null
      }
    })
    logFanOutFallbacks(fallbacks, input, recipients.length)
    if (failed.length > 0) {
      deps.logger?.warn(
        {
          err: firstFailure,
          type: input.type,
          failed: failed.length,
          recipients: recipients.length,
        },
        "fan-out notification insert failed; reported to the caller",
      )
    }
    const created = persisted.filter((p): p is CreatedNotification => p !== null)
    const result = { failed: [...unreadable, ...failed] }
    if (created.length === 0) return result
    const mode = input.push ?? "auto"
    const pushable = created.filter((c) => pushAllowed(c.gate, mode))
    if (pushable.length > 0) {
      void sendBatchedPush(pushable, category).catch((err: unknown) => {
        deps.logger?.error(
          { err, count: pushable.length },
          "batched push dispatch failed (suppressed)",
        )
      })
    }
    void signalMany(created.map((c) => c.userId))
    return result
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

    getPrefs,

    async updatePrefs(
      userId: string,
      patch: UpdateNotificationPrefsRequest,
    ): Promise<NotificationPrefsDTO> {
      await deps.settingsRepo.upsertSettings(userId, settingsPatchFromPrefs(patch))
      if ("quietHours" in patch) {
        await deps.repo.upsertPrefs(userId, { quietHours: patch.quietHours ?? null })
      }
      return getPrefs(userId)
    },

    async registerPushToken(userId: string, req: RegisterPushTokenRequest): Promise<{ ok: true }> {
      const shape = classifyPushToken(req.platform, req.token)
      if (!shape.ok) {
        throw AppError.validation({ [shape.field]: shape.reason }, INVALID_PUSH_TOKEN_MESSAGE)
      }
      if (shape.kind === "web" && (await isSafeEndpoint(shape.endpoint)) === false) {
        throw AppError.validation(
          { token: "subscription endpoint must be a public https push service" },
          INVALID_PUSH_TOKEN_MESSAGE,
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
        deps.logger?.warn(
          { err, userId, platform: req.platform },
          "pushSender.registerToken failed",
        )
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

    createNotification(
      userId: string,
      input: CreateNotificationInput,
    ): Promise<NotificationDTO | null> {
      return doCreateNotification(userId, input)
    },

    async createNotifications(userIds: string[], input: CreateNotificationInput): Promise<void> {
      await doCreateNotifications(userIds, input)
    },

    createNotificationsReportingFailures(
      userIds: string[],
      input: CreateNotificationInput,
    ): Promise<FanOutNotificationResult> {
      return doCreateNotifications(userIds, input)
    },

    async clearByTypeAndLink(userId: string, type: NotificationType, link: string): Promise<void> {
      await deps.repo.clearByTypeAndLink(userId, type, link)
      await maybeSignalNotification(userId)
    },

    async onNewFollower(args: { followeeId: string; follower: PersonView }): Promise<void> {
      await doCreateNotification(args.followeeId, {
        type: "new_follower",
        titleKey: "notification.follower.title",
        bodyKey: "notification.follower.body",
        vars: { name: actorDisplayName(args.follower.displayName, args.follower.handle) },
        link: personLink(args.follower.id),
        dedupeWindowMs: NOTIFICATION_DEDUPE_WINDOW_MS,
      })
    },

    onPostLike: (a: PostActivity) => notifyPostActivity("post_like", a),
    onPostRepost: (a: PostActivity) => notifyPostActivity("post_repost", a),
    onPostReply: (a: PostActivity) => notifyPostActivity("post_reply", a),
    onPostQuote: (a: PostActivity) => notifyPostActivity("post_quote", a),
    onPostMention: (a: PostActivity) => notifyPostActivity("post_mention", a),
  }
}
