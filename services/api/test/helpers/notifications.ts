/**
 * Offline notifications test helper: an in-memory NotificationRepository (feed, read-state, prefs, push
 * tokens).
 *
 * Mirrors the other in-memory seams so the notification SERVICE and the notification HTTP ROUTES can be
 * exercised with NO database (no Docker). It is faithful to the Drizzle impl's observable contract:
 *   - insertNotification assigns an id + createdAt and stores the row;
 *   - listNotifications pages newest-first (createdAt DESC, id DESC) with a `${iso}|${id}` keyset cursor;
 *   - markRead sets readAt for ONLY the user's own, still-unread ids;
 *   - findPrefs/createDefaultPrefs/upsertPrefs manage the 1:1 prefs row (defaults all-true, no quiet hours);
 *     a partial patch leaves untouched columns intact; quietHours null clears both bounds;
 *   - upsertPushToken keys on (platform, token): ownership-scoped re-registration (P1-3) re-points/reactivates
 *     only for the owner or a caller presenting the same non-null device_id; a foreign-owned token is left
 *     untouched ("conflict").
 *
 * The Drizzle-backed repository is covered by the Docker-gated integration test; this fake exercises the
 * same NotificationRepository seam locally.
 */

import { randomUUID } from "node:crypto"
import type {
  NewNotificationArgs,
  NotificationPrefsPatch,
  NotificationPrefsRecord,
  NotificationRecord,
  NotificationRepository,
  PushTokenUpsertOutcome,
} from "../../src/services/notification-service.js"
import { DEFAULT_PREFS } from "../../src/services/notification-service.js"
import type { NotificationType, PushPlatform } from "@civfix/shared"

/** A stored push token row. */
export interface StoredPushToken {
  userId: string
  platform: PushPlatform
  token: string
  deviceId: string | null
  revokedAt: Date | null
}

/** An in-memory NotificationRepository faithful to the Drizzle impl's observable behavior. */
export class InMemoryNotificationRepository implements NotificationRepository {
  readonly notifications: NotificationRecord[] = []
  readonly prefs = new Map<string, NotificationPrefsRecord>()
  readonly pushTokens: StoredPushToken[] = []

  /** Injectable clock so createdAt/read timestamps are deterministic. Defaults to real now. */
  now: () => Date = () => new Date()
  /** Monotonic counter so rows inserted in the same millisecond keep a stable, distinct order. */
  private seq = 0

  insertNotification(args: NewNotificationArgs): Promise<NotificationRecord> {
    // Nudge createdAt forward by the sequence so same-tick inserts have a strict, deterministic order that
    // matches the DESC, id-tiebreak paging (newer = later in insertion order).
    const createdAt = new Date(this.now().getTime() + this.seq)
    this.seq += 1
    const record: NotificationRecord = {
      id: randomUUID(),
      userId: args.userId,
      type: args.type,
      title: args.title,
      body: args.body,
      link: args.link,
      readAt: null,
      createdAt,
    }
    this.notifications.push(record)
    return Promise.resolve(record)
  }

  listNotifications(
    userId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: NotificationRecord[]; nextCursor: string | null }> {
    const mine = this.notifications
      .filter((n) => n.userId === userId)
      // Newest-first (createdAt DESC, id DESC).
      .sort((a, b) => {
        const cmp = b.createdAt.getTime() - a.createdAt.getTime()
        if (cmp !== 0) return cmp
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
      })

    const parsed = parseTimeCursor(cursor)
    const after =
      parsed !== null
        ? mine.filter((n) => {
            const t = n.createdAt.getTime()
            const ct = parsed.at.getTime()
            if (t !== ct) return t < ct
            return n.id < parsed.id
          })
        : mine

    const hasMore = after.length > limit
    const page = hasMore ? after.slice(0, limit) : after
    const last = page[page.length - 1]
    const nextCursor =
      hasMore && last ? `${last.createdAt.toISOString()}|${last.id}` : null
    return Promise.resolve({ records: page, nextCursor })
  }

  markRead(userId: string, ids: string[]): Promise<void> {
    const set = new Set(ids)
    const at = this.now()
    for (const n of this.notifications) {
      if (n.userId === userId && set.has(n.id) && n.readAt === null) {
        n.readAt = at
      }
    }
    return Promise.resolve()
  }

  clearByTypeAndLink(userId: string, type: NotificationType, link: string): Promise<void> {
    // Mirror the Drizzle UPDATE: clear ONLY the user's own, still-unread rows of this (type, link).
    const at = this.now()
    for (const n of this.notifications) {
      if (n.userId === userId && n.type === type && n.link === link && n.readAt === null) {
        n.readAt = at
      }
    }
    return Promise.resolve()
  }

  findPrefs(userId: string): Promise<NotificationPrefsRecord | null> {
    return Promise.resolve(this.prefs.get(userId) ?? null)
  }

  createDefaultPrefs(userId: string): Promise<NotificationPrefsRecord> {
    const existing = this.prefs.get(userId)
    if (existing) return Promise.resolve(existing)
    const row: NotificationPrefsRecord = { ...DEFAULT_PREFS }
    this.prefs.set(userId, row)
    return Promise.resolve(row)
  }

  upsertPrefs(userId: string, patch: NotificationPrefsPatch): Promise<NotificationPrefsRecord> {
    const current = this.prefs.get(userId) ?? { ...DEFAULT_PREFS }
    const next: NotificationPrefsRecord = {
      push: patch.push ?? current.push,
      cleanupChat: patch.cleanupChat ?? current.cleanupChat,
      reportUpdates: patch.reportUpdates ?? current.reportUpdates,
      follows: patch.follows ?? current.follows,
      mentions: patch.mentions ?? current.mentions,
      quietStart:
        patch.quietHours === undefined
          ? current.quietStart
          : patch.quietHours === null
            ? null
            : patch.quietHours.start,
      quietEnd:
        patch.quietHours === undefined
          ? current.quietEnd
          : patch.quietHours === null
            ? null
            : patch.quietHours.end,
    }
    this.prefs.set(userId, next)
    return Promise.resolve(next)
  }

  upsertPushToken(args: {
    userId: string
    platform: PushPlatform
    token: string
    deviceId: string | null
  }): Promise<PushTokenUpsertOutcome> {
    const existing = this.pushTokens.find(
      (t) => t.platform === args.platform && t.token === args.token,
    )
    if (existing) {
      // OWNERSHIP-SCOPED re-registration (P1-3), mirroring the Drizzle ON CONFLICT ... WHERE: only the
      // owner, or a caller presenting the SAME non-null device_id, may re-point/reactivate the row.
      const owner = existing.userId === args.userId
      const sameDevice = args.deviceId !== null && existing.deviceId === args.deviceId
      if (!owner && !sameDevice) {
        // Foreign-owned with no device proof: leave the row untouched (no silent transfer).
        return Promise.resolve("conflict")
      }
      existing.userId = args.userId
      existing.deviceId = args.deviceId
      existing.revokedAt = null
      return Promise.resolve("stored")
    }
    this.pushTokens.push({
      userId: args.userId,
      platform: args.platform,
      token: args.token,
      deviceId: args.deviceId,
      revokedAt: null,
    })
    return Promise.resolve("stored")
  }

  deletePushTokensForUser(userId: string): Promise<void> {
    // Mirror the Drizzle DELETE: remove every push-token row owned by the user (erasure removes the
    // device identifier outright, not a soft-revoke).
    for (let i = this.pushTokens.length - 1; i >= 0; i--) {
      if (this.pushTokens[i]!.userId === userId) this.pushTokens.splice(i, 1)
    }
    return Promise.resolve()
  }
}

/** Parse an `${iso}|${id}` time cursor; null when absent/malformed. Mirrors the Drizzle impl. */
function parseTimeCursor(cursor: string | null): { at: Date; id: string } | null {
  if (cursor === null) return null
  const idx = cursor.indexOf("|")
  if (idx <= 0) return null
  const iso = cursor.slice(0, idx)
  const id = cursor.slice(idx + 1)
  const at = new Date(iso)
  if (Number.isNaN(at.getTime()) || id.length === 0) return null
  return { at, id }
}
