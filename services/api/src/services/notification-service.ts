// Notification service: the in-app feed, read-state, per-user prefs, push-token registration, and the
// createNotification primitive that records a row and INLINE-SENDS a push (pushes are sent synchronously
// from the triggering request, not from a worker). All DB access sits behind NotificationRepository so the
// service is unit-testable with no DB. Pure prefs/quiet-hours/DTO helpers live in notification-helpers.ts
// (re-exported below so existing importers stay stable).

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
  isWithinQuietHours,
  parseTimeOfDayMinutes,
  toNotificationDTO,
  toPrefsDTO,
  typeAllowedByPrefs,
} from "./notification-helpers.js"

export const NOTIFICATIONS_DEFAULT_LIMIT = 20

// markRead forwards ids straight into one `id = ANY(...)` — the shared MarkReadRequest does NOT bound the
// array, so the service caps it to keep a single huge IN-list off the DB.
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

// quietStart/quietEnd are the pg `time` columns as strings ("HH:MM"/"HH:MM:SS"), or null when disabled.
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
  // undefined leaves quiet hours unchanged; null clears them; an object sets both bounds.
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

  // OWNERSHIP-SCOPED re-registration (P1-3). A push token is a device secret; re-pointing the row +
  // clearing revoked_at is allowed ONLY when the caller already owns the row, OR presents the SAME
  // non-null device_id (a genuine device handoff). A token owned by a DIFFERENT user with no device proof
  // is NOT silently transferred — the existing owner keeps it and the attempt returns "conflict". This
  // closes the silent notification-hijack where knowing another user's raw token let you re-point it.
  upsertPushToken(args: {
    userId: string
    platform: PushPlatform
    token: string
    deviceId: string | null
  }): Promise<PushTokenUpsertOutcome>

  // DEVICE-CLAIM (cross-account leak fix). A device's push token must only deliver to the account that is
  // currently signed in ON that device. When a user registers a token with a device_id (the device's own
  // secret, shared across accounts on the device), soft-revoke every OTHER user's active token for that
  // same device_id — they are no longer the signed-in account on this device. Secure: only this device can
  // present its device_id, so this cannot revoke a token on a device the caller does not hold. No-op when
  // no row matches.
  revokeDeviceTokensForOtherUsers(userId: string, deviceId: string): Promise<void>

  // Account erasure (DELETE /me): a push token (token + device_id) is a device identifier, so erasure
  // HARD-deletes the rows rather than soft-revoking (which is what normal rotation does, keeping an audit
  // trail). Idempotent.
  deletePushTokensForUser(userId: string): Promise<void>

  // The recipient's chosen UI/message locale (users.locale). Loaded just before a localized notification
  // is rendered so the persisted title/body + the inline push are in the user's language. Returns null
  // when the user is unknown; the service falls back to the default locale ('en').
  findUserLocale(userId: string): Promise<string | null>
}

export type PushTokenUpsertOutcome = "stored" | "conflict"

/**
 * Create a notification. Copy is supplied in ONE of two forms:
 *   - LOCALIZED (preferred): `titleKey` (+ optional `bodyKey`) into the i18n catalog, with `vars` for
 *     `{{...}}` interpolation. The service loads the recipient's `users.locale` and renders both the
 *     persisted row AND the inline push in that language, falling back to English.
 *   - RAW (legacy / already-localized): a literal `title` (+ optional `body`). Used where the copy is not
 *     localizable (or for back-compat). When both forms are present the KEYS win.
 * `link` is locale-independent.
 */
export interface CreateNotificationInput {
  type: NotificationType
  /** Literal, already-rendered title. Required unless `titleKey` is supplied. */
  title?: string
  /** Literal, already-rendered body. */
  body?: string
  /** i18n catalog key for the title; rendered in the recipient's locale. Takes precedence over `title`. */
  titleKey?: MessageKey
  /** i18n catalog key for the body; rendered in the recipient's locale. Takes precedence over `body`. */
  bodyKey?: MessageKey
  /** `{{var}}` interpolation values for `titleKey`/`bodyKey`. User content (a DM/mention preview) is
   * passed here already-truncated by the caller; only the surrounding wrapper copy is translated. */
  vars?: MessageVars
  link?: string
}

export interface NotificationServiceDeps {
  repo: NotificationRepository
  pushSender: PushSender
  // Optional per-user signal channel: when wired, createNotification fires a best-effort
  // {topic:"notifications"} so a signed-in client refreshes its bell without polling.
  userChannel?: UserChannel
  logger?: Pick<FastifyBaseLogger, "warn" | "error">
  // Injectable clock so the quiet-hours gate is deterministic in tests.
  now?: () => Date
}

// Also satisfies SocialNotifier (onNewFollower) so the social service can fire the new_follower hook
// without importing the concrete service.
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
      // A push failure must never break the triggering request: the row is already persisted.
      deps.logger?.warn(
        { err, userId, notificationId: record.id, type: record.type },
        "inline push send failed (suppressed)",
      )
    }
  }

  // UNGATED by prefs/quiet hours — those gate the PUSH (an out-of-app interruption); the in-app bell badge
  // should always reflect the recorded row. No-op when no channel is wired.
  async function maybeSignalNotification(userId: string): Promise<void> {
    if (!deps.userChannel) return
    try {
      await deps.userChannel.publishToUser(userId, { topic: "notifications" })
    } catch (err) {
      deps.logger?.warn({ err, userId }, "notification signal publish failed (suppressed)")
    }
  }

  // Resolve the recipient's locale (best-effort; falls back to 'en' on any lookup error) ONLY when the
  // input carries i18n keys. A raw-copy notification needs no locale lookup, so we skip the query.
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
    // KEYS win over raw copy. A raw `title` is required when no `titleKey` is given (enforced below); the
    // empty-string fallback only guards an impossible all-undefined case so the column stays NOT NULL.
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
    // Fire-and-forget the realtime bell signal: the row is already persisted and the publish must not
    // block the write, so we void the promise (it swallows + logs its own errors; the .catch is a backstop).
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
        // The token is owned by another user with no device-ownership proof. Do NOT register it with the
        // PushSender either (that would route the foreign device's pushes here). Still return ok so the
        // conflict is not an enumeration oracle for which raw tokens exist.
        deps.logger?.warn(
          { userId, platform: req.platform, hasDeviceId: req.deviceId !== undefined },
          "push token re-registration refused: token owned by another user (no device-ownership proof)",
        )
        return { ok: true }
      }
      // DEVICE-CLAIM (cross-account leak fix): this account is now the one signed in on this device, so any
      // OTHER user's active token for the SAME device must stop receiving here. Gated on a presented
      // device_id (the device's own secret) so it can only ever revoke tokens on the caller's own device.
      if (req.deviceId) {
        try {
          await deps.repo.revokeDeviceTokensForOtherUsers(userId, req.deviceId)
        } catch (err) {
          deps.logger?.warn({ err, userId }, "device-claim revoke failed (suppressed)")
        }
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
