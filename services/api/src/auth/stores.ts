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
import type { Role } from "@civfix/shared"

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// User store
// ---------------------------------------------------------------------------

/** Subset of a users row the auth flows read/write. */
export interface UserRecord {
  id: string
  role: Role
  displayName: string
  handle: string | null
  email: string | null
  emailVerified: boolean
  /** Provider (Google) profile photo URL; null => monogram avatar. */
  avatarUrl: string | null
  /** First-run registration gate: false until the user sets a username + name. */
  profileComplete: boolean
  /** Whether the account accepts NEW direct messages (the DM privacy toggle). Defaults true. */
  allowDirectMessages: boolean
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
  /** First-run registration: set the handle + displayName and mark the profile complete. */
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
}

/** Partial settings patch (PUT /me/settings). Only present fields are written. */
export interface UpdateSettingsInput {
  allowDirectMessages?: boolean
}

/**
 * In-memory UserStore. Email lives directly on the user record and is matched case-insensitively to
 * mirror the CITEXT `users.email` column (no separate index/table, just like the Pg store now reads
 * the column directly).
 */
export class InMemoryUserStore implements UserStore {
  private readonly byId = new Map<string, UserRecord>()

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
    const row: UserRecord = {
      id: randomUUID(),
      role: input.role ?? "citizen",
      displayName: input.displayName,
      handle: null,
      email: email === null ? null : email.toLowerCase(),
      emailVerified: email !== null && (input.emailVerified ?? false),
      avatarUrl: input.avatarUrl ?? null,
      profileComplete: false,
      allowDirectMessages: true,
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

  updateProfile(id: string, input: UpdateProfileInput): Promise<UserRecord> {
    const row = this.byId.get(id)
    if (!row) throw new Error("InMemoryUserStore.updateProfile: user not found")
    const next: UserRecord = {
      ...row,
      handle: input.handle,
      displayName: input.displayName,
      profileComplete: true,
    }
    this.byId.set(id, next)
    return Promise.resolve({ ...next })
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
    }
    this.byId.set(id, next)
    return Promise.resolve({ ...next })
  }

  /** Test helper: seed a user directly (e.g. to test an existing-account sign-in). */
  seed(_email: string | null, row: UserRecord): void {
    this.byId.set(row.id, { ...row })
  }
}

// ---------------------------------------------------------------------------
// OAuth identity store
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// OTP store
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

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
