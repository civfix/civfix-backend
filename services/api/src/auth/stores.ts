/**
 * Persistence seams for the auth subsystem.
 *
 * Each store is a narrow interface over exactly the rows the auth flows touch (sessions, email_otps,
 * users, oauth_identities). Two implementations exist:
 *   - the Drizzle/Postgres impls in pg-stores.ts (durable source of truth, used in production), and
 *   - the InMemory impls below (used by the offline unit + route tests).
 *
 * Splitting persistence behind these interfaces is what lets the session sliding-expiry logic, the
 * Redis hit/miss path, and the full OTP sign-in route run GREEN with no database. The InMemory impls
 * are intentionally faithful: uuid ids, citext-style case-insensitive email matching, ordering by
 * createdAt, soft-delete awareness.
 */

import { randomUUID } from "node:crypto"
import { AppError } from "@civfix/shared"
import type { Role } from "@civfix/shared"
import { decideHandleWrite, handleChanged } from "./handle-policy.js"

/** The rolling rename cooldown: a @handle changed AFTER profile completion locks for 30 days. */
export const HANDLE_RENAME_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Compute the next ISO timestamp a @handle may be changed, or null when it is changeable now. Shared by
 * toUserDTO (the client-facing handleChangeableAt) and the store's cooldown enforcement. null when
 * handle_changed_at is null (never renamed) OR the 30-day window has already elapsed.
 */
export function handleChangeableAtFrom(handleChangedAt: Date | null, now: Date): string | null {
  if (handleChangedAt === null) return null
  const next = new Date(handleChangedAt.getTime() + HANDLE_RENAME_COOLDOWN_MS)
  return next.getTime() > now.getTime() ? next.toISOString() : null
}

/**
 * Generate a unique placeholder @handle for a brand-new account that did not supply one (every OTP/OAuth
 * signup gets one at create() time so the NOT-NULL column is satisfied; the user then picks their real
 * handle in first-run registration). 'user' + the first 12 lowercase-hex chars of a UUID => 16 chars, all
 * [a-z0-9], inside HANDLE_REGEX (3-20). Derived from `id` when available (matches the 0026 backfill), else
 * a fresh random UUID. Unique because the source UUID is unique.
 */
export function generatePlaceholderHandle(id?: string): string {
  const hex = (id ?? randomUUID()).replace(/-/g, "").slice(0, 12).toLowerCase()
  return `user${hex}`
}

/** A persisted session row. `id` is the SHA-256 hex of the raw token. `roles` is denormalized. */
export interface SessionRecord {
  id: string
  userId: string
  roles: Role[]
  createdAt: Date
  expiresAt: Date
  lastSeenAt: Date
  userAgent: string | null
  ip: string | null
}

export interface SessionInsert {
  id: string
  userId: string
  roles: Role[]
  expiresAt: Date
  lastSeenAt: Date
  userAgent: string | null
  ip: string | null
}

export interface SessionStore {
  insert(row: SessionInsert): Promise<void>
  findById(hash: string): Promise<SessionRecord | null>
  updateExpiry(hash: string, expiresAt: Date, lastSeen: Date): Promise<void>
  deleteById(hash: string): Promise<void>
  /**
   * Delete EVERY session row for a user and return the deleted session ids (the token SHA-256 hashes),
   * so the caller can invalidate the matching write-through cache entries. Phase 2: banning a user
   * revokes all of their sessions instantly. Idempotent (an empty result when the user has none).
   */
  deleteAllForUser(userId: string): Promise<string[]>
}

/**
 * In-memory SessionStore. Note that production `sessions` does not have a `roles` column; the Pg impl
 * resolves roles from the user row. The in-memory impl stores them directly so the session-service
 * unit tests do not also need a user store.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly rows = new Map<string, SessionRecord>()

  insert(row: SessionInsert): Promise<void> {
    this.rows.set(row.id, {
      ...row,
      roles: [...row.roles],
      createdAt: new Date(row.lastSeenAt),
    })
    return Promise.resolve()
  }

  findById(hash: string): Promise<SessionRecord | null> {
    const row = this.rows.get(hash)
    return Promise.resolve(row ? { ...row, roles: [...row.roles] } : null)
  }

  updateExpiry(hash: string, expiresAt: Date, lastSeen: Date): Promise<void> {
    const row = this.rows.get(hash)
    if (row) {
      row.expiresAt = expiresAt
      row.lastSeenAt = lastSeen
    }
    return Promise.resolve()
  }

  deleteById(hash: string): Promise<void> {
    this.rows.delete(hash)
    return Promise.resolve()
  }

  deleteAllForUser(userId: string): Promise<string[]> {
    const deleted: string[] = []
    for (const [id, row] of this.rows) {
      if (row.userId === userId) {
        this.rows.delete(id)
        deleted.push(id)
      }
    }
    return Promise.resolve(deleted)
  }

  /** Test helper. */
  count(): number {
    return this.rows.size
  }
}

/** Subset of a users row the auth flows read/write. */
export interface UserRecord {
  id: string
  role: Role
  displayName: string
  /** The @handle (NOT NULL after 0026; always present for a real account). citext server-side. */
  handle: string | null
  /**
   * The rolling-30-day rename cooldown clock. null => never renamed (changeable now). Stamped only by a
   * rename made AFTER profileComplete=true; the handle chosen during first-run registration does NOT stamp
   * it. toUserDTO derives the client-facing `handleChangeableAt` (handle_changed_at + 30 days) from this.
   */
  handleChangedAt: Date | null
  email: string | null
  emailVerified: boolean
  /** Provider (Google) profile photo URL; null => monogram avatar. */
  avatarUrl: string | null
  /** First-run registration gate: false until the user sets a username + name. */
  profileComplete: boolean
  /** Whether the account accepts NEW direct messages (the DM privacy toggle). Defaults true. */
  allowDirectMessages: boolean
  /**
   * Per-account UI/message locale (0033). One supported code {en,es,de,ko}; defaults 'en'. The SOURCE OF
   * TRUTH for server-generated copy (push titles/bodies, account emails). Stored raw; the write path
   * validates against the LocaleEnum, so reads may still need clamping (resolveLocale) before render.
   */
  locale: string
  createdAt: Date
  deletedAt: Date | null
}

export interface CreateUserInput {
  displayName: string
  role?: Role
  /** Whether the associated email is proven (verified OTP / verified-email OAuth). Defaults to false. */
  emailVerified?: boolean
  /** Provider photo URL captured at OAuth sign-in (Google); null for Apple/OTP. */
  avatarUrl?: string | null
  /**
   * An explicit @handle for the new account. Omitted => a generated placeholder derived from the id (the
   * normal signup path; the user picks their real handle in first-run registration). Supplied only by
   * special server-provisioned accounts (the reviewer-OTP bypass) that are born fully set up. The CALLER
   * owns reserved/uniqueness for an explicit handle (e.g. the reviewer handle is on the reserved blocklist
   * so no real user can hold it); the unique index is the backstop.
   */
  handle?: string
  /**
   * Whether the account skips first-run registration. Omitted => false (normal signups must finish the
   * "set username + name" step). Supplied true only for server-provisioned accounts (the reviewer bypass).
   */
  profileComplete?: boolean
}

/** First-run registration update: the username (handle) + display name the user chooses. */
export interface UpdateProfileInput {
  handle: string
  displayName: string
  /**
   * The free-text bio. Present only when the own-profile bio editor submits it (registration omits it);
   * an empty string clears the bio. Omitted (`undefined`) leaves the stored bio untouched.
   */
  bio?: string | null
  /**
   * A finalized media upload id (the avatar picker). When present, the store resolves it to the media row
   * and sets the user's avatar_media_id to that row's id. Omitted (`undefined`) leaves the avatar
   * unchanged. Possessing the finalized upload id is the capability proof (the report flow's model).
   */
  avatarUploadId?: string
  /**
   * Presign (or otherwise render) an avatar object key into the CANONICAL public URL, wrapping the Storage
   * seam's presignGet (in production R2_PUBLIC_BASE makes this a stable, no-expiry CDN URL). When supplied
   * AND `avatarUploadId` resolves to a media row, the store presigns that row's r2_key and PERSISTS the
   * result into users.avatar_url, so avatar_url becomes the single canonical avatar every reader projects.
   * Omitted (the offline in-memory store, which has no media table) leaves avatar_url untouched.
   */
  presignAvatar?: (avatarKey: string) => Promise<string>
}

export interface UserStore {
  findById(id: string): Promise<UserRecord | null>
  /** Look up a user by their `users.email`, case-insensitively (the column is CITEXT). */
  findByEmail(email: string): Promise<UserRecord | null>
  /** Look up a user by their `users.handle`, case-insensitively (the column is CITEXT). */
  findByHandle(handle: string): Promise<UserRecord | null>
  /**
   * Create a user. When `email` is non-null it is stored on `users.email` so a later sign-in with the
   * same address (OTP or OAuth) converges on this user. `input.emailVerified` sets `email_verified`.
   * New users start with `profile_complete = false` (they must finish first-run registration).
   */
  create(email: string | null, input: CreateUserInput): Promise<UserRecord>
  /**
   * First-run registration / profile edit: set the handle + displayName and mark the profile complete.
   * The ROUTE owns the reserved/slur/jurisdiction gate; the STORE owns handle format + uniqueness + the
   * rolling-30-day rename cooldown (see handle-policy.ts). Throws AppError.notFound for an unknown id.
   */
  updateProfile(id: string, input: UpdateProfileInput): Promise<UserRecord>
  /**
   * Set the user's role (Phase 2 admin/gov provisioning). IDEMPOTENT: setting the role a user already
   * holds is a no-op that still returns the row, so the operator-login grant + gov-claim approve can be
   * called repeatedly without error. Returns the updated user.
   */
  setRole(id: string, role: Role): Promise<UserRecord>
  /**
   * Update account/privacy settings (currently just the DM toggle). Only the provided fields are
   * written; omitted fields are left unchanged. Returns the updated user.
   */
  updateSettings(id: string, input: UpdateSettingsInput): Promise<UserRecord>
  /**
   * Self-service account deletion (App-Store-audit remediation). SOFT delete: set `deleted_at = now()`
   * and turn DMs off (`allow_direct_messages = false`), but KEEP the PII columns
   * (`display_name`/`handle`/`email`) so the ADMIN panel retains the real identity — only the PUBLIC
   * author projections render "Deleted User" (branching on `deleted_at`). The users row and every FK to
   * it survive, so the account's reports/comments/events/messages are kept. Idempotent: deleting an
   * already-deleted account re-stamps harmlessly. Returns the tombstoned record.
   */
  softDeleteAndAnonymize(id: string): Promise<UserRecord>
}

/** Partial settings patch (PUT /me/settings). Only present fields are written. */
export interface UpdateSettingsInput {
  allowDirectMessages?: boolean
  /**
   * The user's chosen UI/message locale (the Profile language switcher's `setLocale` when authed). The
   * ROUTE validates/clamps it to a supported code {en,es,de,ko} before this is reached; the store writes
   * it verbatim. Omitted leaves the stored locale unchanged.
   */
  locale?: string
}

/**
 * In-memory UserStore. Email lives directly on the user record and is matched case-insensitively to
 * mirror the CITEXT `users.email` column (no separate index/table, just like the Pg store now reads
 * the column directly).
 */
export class InMemoryUserStore implements UserStore {
  private readonly byId = new Map<string, UserRecord>()
  private readonly now: () => Date

  /** `now` is injectable so tests can drive the rename-cooldown clock deterministically. */
  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date())
  }

  findById(id: string): Promise<UserRecord | null> {
    const row = this.byId.get(id)
    return Promise.resolve(row ? { ...row } : null)
  }

  findByEmail(email: string): Promise<UserRecord | null> {
    const normalized = email.toLowerCase()
    for (const row of this.byId.values()) {
      if (row.email !== null && row.email.toLowerCase() === normalized) {
        return Promise.resolve({ ...row })
      }
    }
    return Promise.resolve(null)
  }

  create(email: string | null, input: CreateUserInput): Promise<UserRecord> {
    // IDEMPOTENT ON EMAIL (P1-4): mirror the Pg store's ON CONFLICT (email) DO NOTHING + re-select. A
    // non-null email that already exists resolves to the existing row instead of creating a duplicate (or
    // throwing), so a concurrent first-sign-in for the same address converges on one user. A null email
    // never conflicts (the partial unique index excludes NULLs), so it always creates a fresh row.
    if (email !== null) {
      const normalized = email.toLowerCase()
      for (const existing of this.byId.values()) {
        if (existing.email !== null && existing.email.toLowerCase() === normalized) {
          return Promise.resolve({ ...existing })
        }
      }
    }
    const id = randomUUID()
    const row: UserRecord = {
      id,
      role: input.role ?? "citizen",
      displayName: input.displayName,
      // Always set a handle so the NOT-NULL column is satisfied: an explicit handle when the caller
      // provides one (server-provisioned accounts), else a generated placeholder derived from the new id
      // (the user picks their real handle in first-run registration). handle_changed_at stays null.
      handle: input.handle ?? generatePlaceholderHandle(id),
      handleChangedAt: null,
      email: email === null ? null : email.toLowerCase(),
      emailVerified: email !== null && (input.emailVerified ?? false),
      avatarUrl: input.avatarUrl ?? null,
      profileComplete: input.profileComplete ?? false,
      allowDirectMessages: true,
      locale: "en",
      createdAt: new Date(),
      deletedAt: null,
    }
    this.byId.set(row.id, row)
    return Promise.resolve({ ...row })
  }

  findByHandle(handle: string): Promise<UserRecord | null> {
    const normalized = handle.toLowerCase()
    for (const row of this.byId.values()) {
      if (row.handle !== null && row.handle.toLowerCase() === normalized) {
        return Promise.resolve({ ...row })
      }
    }
    return Promise.resolve(null)
  }

  async updateProfile(id: string, input: UpdateProfileInput): Promise<UserRecord> {
    const row = this.byId.get(id)
    if (!row) throw AppError.notFound("User not found.")
    // `avatarUploadId`/`presignAvatar` are accepted but a no-op here: the in-memory store has no media
    // table to resolve the upload id against. The Pg store resolves the media row, presigns its r2_key,
    // and persists the canonical public URL into users.avatar_url.

    let handle = row.handle
    let handleChangedAt = row.handleChangedAt
    if (handleChanged(row.handle, input.handle)) {
      const taken = await this.findByHandle(input.handle)
      const decided = decideHandleWrite({
        current: row.handle,
        submitted: input.handle,
        profileComplete: row.profileComplete,
        handleChangedAt: row.handleChangedAt,
        isTaken: taken !== null && taken.id !== id,
        now: this.now(),
      })
      handle = decided.handle
      handleChangedAt = decided.handleChangedAt
    }

    const next: UserRecord = {
      ...row,
      handle,
      handleChangedAt,
      displayName: input.displayName,
      profileComplete: true,
    }
    this.byId.set(id, next)
    return { ...next }
  }

  setRole(id: string, role: Role): Promise<UserRecord> {
    const row = this.byId.get(id)
    if (!row) throw new Error("InMemoryUserStore.setRole: user not found")
    // Idempotent: writing the same role is a harmless no-op that still returns the row.
    const next: UserRecord = { ...row, role }
    this.byId.set(id, next)
    return Promise.resolve({ ...next })
  }

  updateSettings(id: string, input: UpdateSettingsInput): Promise<UserRecord> {
    const row = this.byId.get(id)
    if (!row) throw new Error("InMemoryUserStore.updateSettings: user not found")
    const next: UserRecord = {
      ...row,
      ...(input.allowDirectMessages !== undefined
        ? { allowDirectMessages: input.allowDirectMessages }
        : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
    }
    this.byId.set(id, next)
    return Promise.resolve({ ...next })
  }

  softDeleteAndAnonymize(id: string): Promise<UserRecord> {
    const row = this.byId.get(id)
    if (!row) throw new Error("InMemoryUserStore.softDeleteAndAnonymize: user not found")
    // SOFT delete: tombstone + turn DMs off, KEEP display_name/handle/email (admin truth). The public
    // projectors branch on deletedAt to render "Deleted User".
    const next: UserRecord = {
      ...row,
      deletedAt: row.deletedAt ?? new Date(),
      allowDirectMessages: false,
    }
    this.byId.set(id, next)
    return Promise.resolve({ ...next })
  }

  /** Test helper: seed a user directly (e.g. to test an existing-account sign-in). */
  seed(_email: string | null, row: UserRecord): void {
    this.byId.set(row.id, { ...row })
  }
}

export interface OAuthIdentityRecord {
  id: string
  userId: string
  provider: string
  providerUserId: string
}

export interface OAuthIdentityStore {
  findByProvider(provider: string, providerUserId: string): Promise<OAuthIdentityRecord | null>
  /** Attach a provider identity to an existing user. Globally unique on (provider, providerUserId). */
  linkIdentity(userId: string, provider: string, providerUserId: string): Promise<void>
}

/** In-memory OAuthIdentityStore. Holds only identity rows; users live in the UserStore. */
export class InMemoryOAuthIdentityStore implements OAuthIdentityStore {
  private readonly identities = new Map<string, OAuthIdentityRecord>()

  private key(provider: string, providerUserId: string): string {
    return `${provider}:${providerUserId}`
  }

  findByProvider(provider: string, providerUserId: string): Promise<OAuthIdentityRecord | null> {
    const row = this.identities.get(this.key(provider, providerUserId))
    return Promise.resolve(row ? { ...row } : null)
  }

  linkIdentity(userId: string, provider: string, providerUserId: string): Promise<void> {
    const k = this.key(provider, providerUserId)
    this.identities.set(k, { id: randomUUID(), userId, provider, providerUserId })
    return Promise.resolve()
  }
}

export interface OtpRecord {
  id: string
  email: string
  codeHash: string
  expiresAt: Date
  attempts: number
  consumedAt: Date | null
  createdAt: Date
}

export interface OtpInsert {
  email: string
  codeHash: string
  expiresAt: Date
}

export interface OtpStore {
  /** Mark every unconsumed code for an email as consumed (resend invalidates prior codes). */
  invalidateActiveForEmail(email: string): Promise<void>
  insert(row: OtpInsert): Promise<OtpRecord>
  /** Most recent unconsumed, non-expired code for an email, or null. */
  findLatestActive(email: string, now: Date): Promise<OtpRecord | null>
  incrementAttempts(id: string): Promise<number>
  markConsumed(id: string, at: Date): Promise<void>
}

/** In-memory OtpStore. Email matched case-insensitively; latest = max createdAt. */
export class InMemoryOtpStore implements OtpStore {
  private readonly rows: OtpRecord[] = []

  invalidateActiveForEmail(email: string): Promise<void> {
    const now = new Date()
    for (const row of this.rows) {
      if (row.email.toLowerCase() === email.toLowerCase() && row.consumedAt === null) {
        row.consumedAt = now
      }
    }
    return Promise.resolve()
  }

  insert(row: OtpInsert): Promise<OtpRecord> {
    const record: OtpRecord = {
      id: randomUUID(),
      email: row.email,
      codeHash: row.codeHash,
      expiresAt: row.expiresAt,
      attempts: 0,
      consumedAt: null,
      createdAt: new Date(),
    }
    this.rows.push(record)
    return Promise.resolve({ ...record })
  }

  findLatestActive(email: string, now: Date): Promise<OtpRecord | null> {
    let best: OtpRecord | null = null
    for (const row of this.rows) {
      if (row.email.toLowerCase() !== email.toLowerCase()) continue
      if (row.consumedAt !== null) continue
      if (row.expiresAt.getTime() <= now.getTime()) continue
      if (!best || row.createdAt.getTime() > best.createdAt.getTime()) best = row
    }
    return Promise.resolve(best ? { ...best } : null)
  }

  incrementAttempts(id: string): Promise<number> {
    const row = this.rows.find((r) => r.id === id)
    if (!row) return Promise.resolve(0)
    row.attempts += 1
    return Promise.resolve(row.attempts)
  }

  markConsumed(id: string, at: Date): Promise<void> {
    const row = this.rows.find((r) => r.id === id)
    if (row) row.consumedAt = at
    return Promise.resolve()
  }

  /** Test helper. */
  all(): readonly OtpRecord[] {
    return this.rows
  }
}

/** All auth persistence seams grouped, for convenient construction/injection. */
export interface AuthStores {
  sessions: SessionStore
  users: UserStore
  oauth: OAuthIdentityStore
  otps: OtpStore
}

/** Build a fully-wired set of in-memory stores. */
export function makeInMemoryStores(): AuthStores & {
  users: InMemoryUserStore
  sessions: InMemorySessionStore
  oauth: InMemoryOAuthIdentityStore
  otps: InMemoryOtpStore
} {
  return {
    users: new InMemoryUserStore(),
    sessions: new InMemorySessionStore(),
    oauth: new InMemoryOAuthIdentityStore(),
    otps: new InMemoryOtpStore(),
  }
}
