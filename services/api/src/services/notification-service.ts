/**
 * Notification service: the in-app feed, read-state, per-user preferences, push-token registration, and
 * the createNotification primitive that records a row and INLINE-SENDS a push (plan section 14: pushes are
 * sent synchronously from the triggering request, not from a separate worker).
 *
 * All DB access sits behind a NotificationRepository seam (Drizzle impl in
 * notification-repository.drizzle.ts; an in-memory impl in the offline tests), mirroring the
 * reports/cleanups/social pattern so the service is unit-testable with no database and no Docker.
 *
 * INLINE-SEND GATING (createNotification):
 *   1. Always insert the notification row (the in-app feed records it regardless of push settings).
 *   2. THEN, best-effort, attempt a push IF AND ONLY IF the user's prefs allow it:
 *        - prefs.push is on (the master switch), AND
 *        - the per-type toggle for this notification type is on (report_update -> reportUpdates,
 *          cleanup_chat -> cleanupChat, new_follower -> follows; the remaining types follow the closest
 *          toggle, see typeAllowedByPrefs), AND
 *        - now is NOT within the user's quiet hours (isWithinQuietHours, a PURE wrap-around-aware check).
 *   3. A push failure NEVER breaks the triggering request: the PushSender.send call is wrapped in
 *      try/catch and only logged. The row is already persisted, so the feed is correct even if delivery
 *      fails or is suppressed.
 *
 * QUIET HOURS: isWithinQuietHours(now, start, end) is pure and handles the wrap-around-midnight window
 * (e.g. 22:00..07:00 spans midnight). Unit-tested across same-day, wrap-around, equal-bounds, and
 * malformed-input cases.
 *
 * PREFS: getPrefs returns the row, creating all-true defaults (no quiet hours) on first read. updatePrefs
 * upserts a partial patch. quietHours is stored as two `time` columns; absent quietHours clears both.
 */

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

// ---------------------------------------------------------------------------
// Config constants
// ---------------------------------------------------------------------------

/** Default page size for listNotifications when the request omits `limit`. Matches the shared cap of 50. */
export const NOTIFICATIONS_DEFAULT_LIMIT = 20

// ---------------------------------------------------------------------------
// Repository seam (structural views; faked in tests)
// ---------------------------------------------------------------------------

/** A persisted notification row the service projects into a NotificationDTO (read = readAt != null). */
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

/** Fields to persist for a new notification. id/createdAt are assigned by the repository. */
export interface NewNotificationArgs {
  userId: string
  type: NotificationType
  title: string
  body: string | null
  link: string | null
}

/**
 * The stored prefs row. quietStart/quietEnd are the pg `time` columns as strings ("HH:MM" or "HH:MM:SS"),
 * or null when quiet hours are disabled. The booleans default to true on first create.
 */
export interface NotificationPrefsRecord {
  push: boolean
  cleanupChat: boolean
  reportUpdates: boolean
  follows: boolean
  quietStart: string | null
  quietEnd: string | null
}

/** A partial prefs patch as updatePrefs persists it. `quietHours` null clears both time columns. */
export interface NotificationPrefsPatch {
  push?: boolean
  cleanupChat?: boolean
  reportUpdates?: boolean
  follows?: boolean
  /** undefined leaves quiet hours unchanged; null clears them; an object sets both bounds. */
  quietHours?: QuietHours | null
}

/**
 * Persistence seam for the notifications domain. The production impl runs Drizzle; the offline tests pass
 * an in-memory implementation. Keeping ALL notification/prefs/push-token access behind this interface is
 * what makes the service testable with no DB.
 */
export interface NotificationRepository {
  /** Insert a notification row and return it (id + createdAt assigned). */
  insertNotification(args: NewNotificationArgs): Promise<NotificationRecord>

  /** Page a user's notifications newest-first. Returns up to `limit` rows + next cursor (null when done). */
  listNotifications(
    userId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: NotificationRecord[]; nextCursor: string | null }>

  /** Set read_at=now for the given ids that BELONG to the user (others are ignored). */
  markRead(userId: string, ids: string[]): Promise<void>

  /**
   * Clear (mark read) the user's still-unread notifications of a given type whose link matches exactly.
   * Used to dismiss the bell for a conversation when its messages are read (e.g. type='dm' + the dm
   * thread link, or type='cleanup_chat' + the cleanup link). The user_id + read_at IS NULL guards mirror
   * markRead (only the user's own, still-unread rows are touched).
   */
  clearByTypeAndLink(userId: string, type: NotificationType, link: string): Promise<void>

  /** Load a user's prefs row, or null when none exists yet. */
  findPrefs(userId: string): Promise<NotificationPrefsRecord | null>

  /** Create the default prefs row (all booleans true, no quiet hours) and return it. */
  createDefaultPrefs(userId: string): Promise<NotificationPrefsRecord>

  /** Upsert a partial prefs patch and return the resulting full row. */
  upsertPrefs(userId: string, patch: NotificationPrefsPatch): Promise<NotificationPrefsRecord>

  /**
   * Upsert a push token (unique(platform, token)) with OWNERSHIP-SCOPED re-registration (P1-3).
   *
   * A push token is a device secret. Re-registering is allowed to (re-)point the row + clear revoked_at
   * ONLY when the caller already owns the row, OR presents the SAME non-null device_id as the existing
   * row (a genuine device handoff/re-provision). A token currently owned by a DIFFERENT user that the
   * caller cannot prove device ownership of is NOT silently transferred - the existing owner keeps it and
   * the attempt is reported as a conflict (the caller logs it). This closes the silent notification
   * hijack / denial-of-delivery where knowing another user's raw token let you re-point it to yourself.
   *
   * Returns the outcome so the caller can log a conflict:
   *   - "stored"   the token was inserted, or re-pointed/reactivated for an owner/same-device caller.
   *   - "conflict" a different user owns the token and ownership was NOT transferred (left untouched).
   */
  upsertPushToken(args: {
    userId: string
    platform: PushPlatform
    token: string
    deviceId: string | null
  }): Promise<PushTokenUpsertOutcome>

  /**
   * Hard-DELETE every push token belonging to a user. Used by account erasure (DELETE /me): a push token
   * (token + device_id) is a device identifier, so deletion removes it entirely rather than leaving it
   * behind, and stops any further delivery to a deleted account's devices. This differs from normal token
   * rotation, which SOFT-revokes (revoked_at) to keep a device audit trail. Idempotent (zero rows is fine).
   */
  deletePushTokensForUser(userId: string): Promise<void>
}

/** Outcome of upsertPushToken: stored (insert/owner-update) vs conflict (foreign-owned, untouched). */
export type PushTokenUpsertOutcome = "stored" | "conflict"

// ---------------------------------------------------------------------------
// Pure helpers (no DB, no IO)
// ---------------------------------------------------------------------------

/** Default prefs values (all channels on, no quiet hours). Used when a prefs row does not exist yet. */
export const DEFAULT_PREFS: NotificationPrefsRecord = {
  push: true,
  cleanupChat: true,
  reportUpdates: true,
  follows: true,
  quietStart: null,
  quietEnd: null,
}

/**
 * Parse an "HH:MM" / "HH:MM:SS" time-of-day string into minutes-since-midnight (0..1439). Returns null for
 * a malformed value (so quiet-hours math can fail safe to "not quiet"). Seconds are floored into the
 * minute. Pure.
 */
export function parseTimeOfDayMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
  if (!m) return null
  const hours = Number(m[1])
  const mins = Number(m[2])
  if (hours > 23 || mins > 59) return null
  return hours * 60 + mins
}

/**
 * Whether `now` falls within the quiet-hours window [start, end), handling wrap-around midnight. PURE.
 *
 *   - start === end          -> window is empty (never quiet); returns false. (Treating it as "always
 *                               quiet" would silently suppress every push on a misconfigured equal pair.)
 *   - start <  end           -> same-day window: quiet when start <= t < end.
 *   - start >  end           -> wrap-around window (e.g. 22:00..07:00): quiet when t >= start OR t < end.
 *   - malformed start/end    -> not quiet (fail open so a bad config does not silently drop pushes).
 *
 * `now` is a Date; only its local hours/minutes are used (the pg `time` columns are wall-clock, no tz).
 */
export function isWithinQuietHours(
  now: Date,
  start: string | null,
  end: string | null,
): boolean {
  if (start === null || end === null) return false
  const s = parseTimeOfDayMinutes(start)
  const e = parseTimeOfDayMinutes(end)
  if (s === null || e === null) return false
  if (s === e) return false
  const t = now.getHours() * 60 + now.getMinutes()
  if (s < e) return t >= s && t < e
  // Wrap-around: the window crosses midnight.
  return t >= s || t < e
}

/**
 * Whether the user's prefs permit a push for `type`. Requires the master push switch AND the per-type
 * toggle. Type -> toggle mapping:
 *   - report_update, claim_available -> reportUpdates (report-related)
 *   - cleanup_chat, cleanup_reminder -> cleanupChat   (cleanup-related)
 *   - new_follower                   -> follows
 *   - system                          -> always allowed when push is on (operational messages)
 * PURE.
 */
export function typeAllowedByPrefs(type: NotificationType, prefs: NotificationPrefsRecord): boolean {
  if (!prefs.push) return false
  switch (type) {
    case "report_update":
    case "claim_available":
      return prefs.reportUpdates
    case "cleanup_chat":
    case "cleanup_reminder":
      return prefs.cleanupChat
    case "new_follower":
      return prefs.follows
    case "system":
      return true
    default:
      return true
  }
}

/** Project a stored prefs row into the wire NotificationPrefsDTO (quietHours present only when both set). */
export function toPrefsDTO(row: NotificationPrefsRecord): NotificationPrefsDTO {
  const hasQuiet = row.quietStart !== null && row.quietEnd !== null
  return {
    push: row.push,
    cleanupChat: row.cleanupChat,
    reportUpdates: row.reportUpdates,
    follows: row.follows,
    ...(hasQuiet ? { quietHours: { start: row.quietStart!, end: row.quietEnd! } } : {}),
  }
}

/** Project a stored notification row into the wire NotificationDTO (read = readAt != null). */
export function toNotificationDTO(record: NotificationRecord): NotificationDTO {
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    ...(record.body !== null ? { body: record.body } : {}),
    read: record.readAt !== null,
    createdAt: record.createdAt.toISOString(),
    ...(record.link !== null ? { link: record.link } : {}),
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Input to createNotification. type/title required; body/link optional. */
export interface CreateNotificationInput {
  type: NotificationType
  title: string
  body?: string
  link?: string
}

export interface NotificationServiceDeps {
  repo: NotificationRepository
  /** The push seam (FakePushSender in dev/test; MultiPushSender in production). */
  pushSender: PushSender
  /**
   * Optional per-user signal channel. When wired, createNotification fires a best-effort
   * `{topic:"notifications"}` invalidate-signal so a signed-in client refreshes its bell without polling.
   * Absent ⇒ no signal (the in-app feed row is still recorded; the client picks it up on its next fetch).
   */
  userChannel?: UserChannel
  /** Logger for the swallowed-push-failure path. Optional; defaults to a no-op. */
  logger?: Pick<FastifyBaseLogger, "warn" | "error">
  /** Injectable clock (defaults to () => new Date()) so the quiet-hours gate is deterministic in tests. */
  now?: () => Date
}

/**
 * The notification service surface. It also satisfies SocialNotifier (via onNewFollower) so the social
 * service can fire the new_follower hook without importing the concrete service.
 */
export interface NotificationService extends SocialNotifier {
  listNotifications(userId: string, pagination: PaginationQuery): Promise<ListNotificationsResponse>
  markRead(userId: string, ids: string[]): Promise<{ ok: true }>
  getPrefs(userId: string): Promise<NotificationPrefsDTO>
  updatePrefs(userId: string, patch: UpdateNotificationPrefsRequest): Promise<NotificationPrefsDTO>
  registerPushToken(userId: string, req: RegisterPushTokenRequest): Promise<{ ok: true }>
  /** Record a notification row + best-effort inline push. Returns the persisted row's DTO. */
  createNotification(userId: string, input: CreateNotificationInput): Promise<NotificationDTO>
  /**
   * Clear (mark read) the user's unread notifications of `type` whose `link` matches exactly, then fire the
   * `{topic:"notifications"}` signal so an open bell refreshes. Best-effort on the signal (the rows are
   * cleared regardless). Used by the read paths to dismiss the bell for a conversation that was just read.
   */
  clearByTypeAndLink(userId: string, type: NotificationType, link: string): Promise<void>
}

export function makeNotificationService(deps: NotificationServiceDeps): NotificationService {
  const now = deps.now ?? (() => new Date())

  /** Resolve a user's prefs, creating the default row on first read. */
  async function resolvePrefs(userId: string): Promise<NotificationPrefsRecord> {
    const existing = await deps.repo.findPrefs(userId)
    if (existing) return existing
    return deps.repo.createDefaultPrefs(userId)
  }

  /**
   * Best-effort inline push for a freshly-recorded notification. Gated by prefs (master + per-type) and
   * quiet hours. Never throws: a suppressed or failed push is logged, not propagated. Separated out so
   * createNotification stays readable and the gating is unit-testable via the public method.
   */
  async function maybeSendPush(
    userId: string,
    record: NotificationRecord,
  ): Promise<void> {
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
      // A push failure must never break the triggering request. The row is already persisted.
      deps.logger?.warn(
        { err, userId, notificationId: record.id, type: record.type },
        "inline push send failed (suppressed)",
      )
    }
  }

  /**
   * Best-effort per-user signal for a freshly-recorded notification: a single `{topic:"notifications"}`
   * invalidate-signal so a signed-in client refreshes its bell without polling. UNGATED by prefs/quiet
   * hours — those gate the PUSH delivery (an out-of-app interruption); the in-app feed badge should always
   * reflect the recorded row. Never throws: the row is already persisted, so a signal failure is logged,
   * not propagated. No-op when no channel is wired.
   */
  async function maybeSignalNotification(userId: string): Promise<void> {
    if (!deps.userChannel) return
    try {
      await deps.userChannel.publishToUser(userId, { topic: "notifications" })
    } catch (err) {
      deps.logger?.warn({ err, userId }, "notification signal publish failed (suppressed)")
    }
  }

  /**
   * Record a notification row + best-effort inline push. The shared implementation behind both the public
   * createNotification method and the onNewFollower hook, so neither relies on `this` (safe to destructure).
   */
  async function doCreateNotification(
    userId: string,
    input: CreateNotificationInput,
  ): Promise<NotificationDTO> {
    // 1) Always record the row (the in-app feed is authoritative regardless of push settings).
    const record = await deps.repo.insertNotification({
      userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
    })
    // 2) Best-effort inline push (gated by prefs + quiet hours; never throws).
    await maybeSendPush(userId, record)
    // 3) Best-effort realtime signal so an open client refreshes its bell now. FIRE-AND-FORGET: the row
    // is already persisted, and the realtime publish must never block or delay the write — so we void the
    // promise (it swallows its own errors and logs; the outer .catch is a defensive backstop) and return
    // without awaiting the Redis PUBLISH round-trip. Mirrors the threads-signal pattern in the WS gateway.
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
      // Empty list is a valid no-op (idempotent). Only the user's own ids are affected (enforced in repo).
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
      // Ensure a row exists first (so a partial update of a never-seen user starts from the defaults), then
      // apply the patch. quietHours is passed through verbatim (undefined leaves it; null clears it).
      await resolvePrefs(userId)
      const repoPatch: NotificationPrefsPatch = {
        ...(patch.push !== undefined ? { push: patch.push } : {}),
        ...(patch.cleanupChat !== undefined ? { cleanupChat: patch.cleanupChat } : {}),
        ...(patch.reportUpdates !== undefined ? { reportUpdates: patch.reportUpdates } : {}),
        ...(patch.follows !== undefined ? { follows: patch.follows } : {}),
        ...("quietHours" in patch ? { quietHours: patch.quietHours ?? null } : {}),
      }
      return toPrefsDTO(await deps.repo.upsertPrefs(userId, repoPatch))
    },

    async registerPushToken(
      userId: string,
      req: RegisterPushTokenRequest,
    ): Promise<{ ok: true }> {
      // Persist via the repo (the canonical push_tokens store the real PushSender.send() reads). The repo
      // enforces ownership-scoped re-registration (P1-3): a token owned by a DIFFERENT user is not
      // silently transferred. On such a conflict we DO NOT register the token with the PushSender either
      // (that would route the foreign device's pushes to this user), and we log it. The endpoint still
      // returns ok so the conflict is not an enumeration oracle for which raw tokens exist.
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
      // Clear the matching unread rows (the in-app feed badge is authoritative; this dismisses the bell for
      // a conversation that was just read), then fire the same realtime signal createNotification uses so an
      // open bell refreshes now. The signal is best-effort (maybeSignalNotification swallows + logs).
      await deps.repo.clearByTypeAndLink(userId, type, link)
      await maybeSignalNotification(userId)
    },

    async onNewFollower(args: {
      followeeId: string
      follower: PersonView
    }): Promise<void> {
      // The new_follower hook (called by the social service). Records a notification for the followed user
      // and inline-sends a push when allowed. Self-contained title/body/link so the social service does not
      // shape copy. A friendly display name falls back to the handle, then a generic phrase.
      const name =
        args.follower.displayName.trim() !== ""
          ? args.follower.displayName
          : args.follower.handle
            ? `@${args.follower.handle}`
            : "Someone"
      await doCreateNotification(args.followeeId, {
        type: "new_follower",
        title: "New follower",
        body: `${name} started following you.`,
        link: `/people/${args.follower.id}`,
      })
    },
  }
}
