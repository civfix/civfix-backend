/**
 * Drizzle/Postgres implementations of the auth persistence seams (the durable source of truth used
 * in production and in the Docker-gated integration tests).
 *
 * Notes on fidelity to the schema:
 *   - sessions has no `roles` column; roles are denormalized into the cached projection but resolved
 *     from the user's `role` when a session is read from Postgres (cache miss / re-warm).
 *   - email + handle are CITEXT, so equality is case-insensitive in the database; we still lower-case
 *     on write for tidy storage.
 *   - oauth_identities.(provider, provider_user_id) is globally unique; linkIdentity is written as an
 *     idempotent upsert so a repeat sign-in does not error on the unique index.
 */

import { and, desc, eq, gt, isNull, sql } from "drizzle-orm"
import type { Db } from "../db/client.js"
import { emailOtps, oauthIdentities, sessions, users } from "../db/schema/index.js"
import type { Role } from "@civfix/shared"
import type {
  AuthStores,
  CreateUserInput,
  OAuthIdentityRecord,
  OAuthIdentityStore,
  OtpInsert,
  OtpRecord,
  OtpStore,
  SessionInsert,
  SessionRecord,
  SessionStore,
  UpdateProfileInput,
  UserRecord,
  UserStore,
} from "./stores.js"

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export class PgSessionStore implements SessionStore {
  constructor(private readonly db: Db) {}

  async insert(row: SessionInsert): Promise<void> {
    await this.db.insert(sessions).values({
      id: row.id,
      userId: row.userId,
      expiresAt: row.expiresAt,
      lastSeenAt: row.lastSeenAt,
      userAgent: row.userAgent,
      ip: row.ip,
    })
  }

  async findById(hash: string): Promise<SessionRecord | null> {
    // Join the user to resolve roles (sessions has no roles column) in a single round trip.
    const rows = await this.db
      .select({
        id: sessions.id,
        userId: sessions.userId,
        role: users.role,
        createdAt: sessions.createdAt,
        expiresAt: sessions.expiresAt,
        lastSeenAt: sessions.lastSeenAt,
        userAgent: sessions.userAgent,
        ip: sessions.ip,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, hash))
      .limit(1)

    const r = rows[0]
    if (!r) return null
    return {
      id: r.id,
      userId: r.userId,
      roles: rolesFor(r.role),
      createdAt: r.createdAt ?? r.lastSeenAt,
      expiresAt: r.expiresAt,
      lastSeenAt: r.lastSeenAt,
      userAgent: r.userAgent,
      ip: r.ip,
    }
  }

  async updateExpiry(hash: string, expiresAt: Date, lastSeen: Date): Promise<void> {
    await this.db
      .update(sessions)
      .set({ expiresAt, lastSeenAt: lastSeen })
      .where(eq(sessions.id, hash))
  }

  async deleteById(hash: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, hash))
  }

  async deleteAllForUser(userId: string): Promise<string[]> {
    // Delete every session row for the user and RETURN the ids (token hashes) so the caller can drop the
    // matching write-through cache entries (the durable row is the source of truth; the cache is keyed by
    // the same id). Phase 2: a ban revokes all of the user's sessions instantly.
    const deleted = await this.db
      .delete(sessions)
      .where(eq(sessions.userId, userId))
      .returning({ id: sessions.id })
    return deleted.map((r) => r.id)
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * Reads/writes the real `users.email` column (CITEXT, partial-unique when non-null). find-or-create
 * by email resolves directly off that column, so `oauth_identities` is now ONLY for apple/google
 * provider links and no longer carries a synthetic "email" pseudo-provider row.
 */
export class PgUserStore implements UserStore {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<UserRecord | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1)
    const r = rows[0]
    return r ? toUserRecord(r) : null
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    // CITEXT makes equality case-insensitive in the database; lower-case for tidy comparison.
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1)
    const r = rows[0]
    return r ? toUserRecord(r) : null
  }

  /**
   * Create a user. IDEMPOTENT ON EMAIL (P1-4): two concurrent first-sign-ins for the SAME brand-new
   * email both see findByEmail = null and both INSERT; without this the second trips users_email_key and
   * throws an unhandled 500. We use ON CONFLICT (email) DO NOTHING and, when our INSERT lost the race (no
   * row returned), re-select the winner's row so BOTH callers resolve to the same user instead of one
   * 500ing. A null email cannot conflict on the partial index, so it always inserts.
   */
  async create(email: string | null, input: CreateUserInput): Promise<UserRecord> {
    const normalizedEmail = email === null ? null : email.toLowerCase()
    const inserted = await this.db
      .insert(users)
      .values({
        displayName: input.displayName,
        role: input.role ?? "citizen",
        email: normalizedEmail,
        emailVerified: email !== null && (input.emailVerified ?? false),
        avatarUrl: input.avatarUrl ?? null,
        // profile_complete uses the column default (false): new users must finish first-run registration.
      })
      // The unique index on email is PARTIAL (WHERE email IS NOT NULL), so the conflict target must carry
      // the same predicate for Postgres to infer it. For onConflictDoNothing, Drizzle emits the index
      // predicate from `where` -> ON CONFLICT (email) WHERE email IS NOT NULL DO NOTHING.
      .onConflictDoNothing({ target: users.email, where: sql`${users.email} is not null` })
      .returning()
    const row = inserted[0]
    if (row) return toUserRecord(row)

    // Our INSERT was a no-op because a concurrent create won the unique email. Re-select that winner.
    if (normalizedEmail !== null) {
      const existing = await this.findByEmail(normalizedEmail)
      if (existing) return existing
    }
    throw new Error("PgUserStore.create: insert returned no row")
  }

  async findByHandle(handle: string): Promise<UserRecord | null> {
    // `handle` is CITEXT, so the eq comparison is case-insensitive at the DB.
    const rows = await this.db.select().from(users).where(eq(users.handle, handle)).limit(1)
    const r = rows[0]
    return r ? toUserRecord(r) : null
  }

  async updateProfile(id: string, input: UpdateProfileInput): Promise<UserRecord> {
    const updated = await this.db
      .update(users)
      .set({ handle: input.handle, displayName: input.displayName, profileComplete: true })
      .where(eq(users.id, id))
      .returning()
    const r = updated[0]
    if (!r) throw new Error("PgUserStore.updateProfile: user not found")
    return toUserRecord(r)
  }

  /**
   * Set the user's role (Phase 2 admin/gov provisioning). A plain UPDATE: writing the role the user
   * already holds is a harmless no-op, so the operator-login grant + gov-claim approve are idempotent.
   */
  async setRole(id: string, role: Role): Promise<UserRecord> {
    const updated = await this.db.update(users).set({ role }).where(eq(users.id, id)).returning()
    const r = updated[0]
    if (!r) throw new Error("PgUserStore.setRole: user not found")
    return toUserRecord(r)
  }
}

// ---------------------------------------------------------------------------
// OAuth identities
// ---------------------------------------------------------------------------

export class PgOAuthIdentityStore implements OAuthIdentityStore {
  constructor(private readonly db: Db) {}

  async findByProvider(
    provider: string,
    providerUserId: string,
  ): Promise<OAuthIdentityRecord | null> {
    const rows = await this.db
      .select()
      .from(oauthIdentities)
      .where(
        and(
          eq(oauthIdentities.provider, provider),
          eq(oauthIdentities.providerUserId, providerUserId),
        ),
      )
      .limit(1)
    const r = rows[0]
    return r
      ? { id: r.id, userId: r.userId, provider: r.provider, providerUserId: r.providerUserId }
      : null
  }

  async linkIdentity(userId: string, provider: string, providerUserId: string): Promise<void> {
    await this.db
      .insert(oauthIdentities)
      .values({ userId, provider, providerUserId })
      .onConflictDoNothing()
  }
}

// ---------------------------------------------------------------------------
// OTPs
// ---------------------------------------------------------------------------

export class PgOtpStore implements OtpStore {
  constructor(private readonly db: Db) {}

  async invalidateActiveForEmail(email: string): Promise<void> {
    await this.db
      .update(emailOtps)
      .set({ consumedAt: new Date() })
      .where(and(eq(emailOtps.email, email.toLowerCase()), isNull(emailOtps.consumedAt)))
  }

  async insert(row: OtpInsert): Promise<OtpRecord> {
    const inserted = await this.db
      .insert(emailOtps)
      .values({
        email: row.email.toLowerCase(),
        codeHash: row.codeHash,
        expiresAt: row.expiresAt,
      })
      .returning()
    const r = inserted[0]
    if (!r) throw new Error("PgOtpStore.insert: insert returned no row")
    return toOtpRecord(r)
  }

  async findLatestActive(email: string, now: Date): Promise<OtpRecord | null> {
    const rows = await this.db
      .select()
      .from(emailOtps)
      .where(
        and(
          eq(emailOtps.email, email.toLowerCase()),
          isNull(emailOtps.consumedAt),
          gt(emailOtps.expiresAt, now),
        ),
      )
      .orderBy(desc(emailOtps.createdAt))
      .limit(1)
    const r = rows[0]
    return r ? toOtpRecord(r) : null
  }

  async incrementAttempts(id: string): Promise<number> {
    const updated = await this.db
      .update(emailOtps)
      .set({ attempts: sql`${emailOtps.attempts} + 1` })
      .where(eq(emailOtps.id, id))
      .returning({ attempts: emailOtps.attempts })
    return updated[0]?.attempts ?? 0
  }

  async markConsumed(id: string, at: Date): Promise<void> {
    await this.db.update(emailOtps).set({ consumedAt: at }).where(eq(emailOtps.id, id))
  }
}

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

/** All Postgres-backed auth stores wired to one Drizzle client. */
export class PgAuthStores implements AuthStores {
  readonly sessions: SessionStore
  readonly users: UserStore
  readonly oauth: OAuthIdentityStore
  readonly otps: OtpStore

  constructor(db: Db) {
    this.sessions = new PgSessionStore(db)
    this.users = new PgUserStore(db)
    this.oauth = new PgOAuthIdentityStore(db)
    this.otps = new PgOtpStore(db)
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

interface UserRowLike {
  id: string
  role: Role
  displayName: string
  handle: string | null
  email: string | null
  emailVerified: boolean
  avatarUrl: string | null
  profileComplete: boolean
  createdAt: Date
  deletedAt: Date | null
}

function toUserRecord(r: UserRowLike): UserRecord {
  return {
    id: r.id,
    role: r.role,
    displayName: r.displayName,
    handle: r.handle,
    email: r.email,
    emailVerified: r.emailVerified,
    avatarUrl: r.avatarUrl,
    profileComplete: r.profileComplete,
    createdAt: r.createdAt,
    deletedAt: r.deletedAt,
  }
}

interface OtpRowLike {
  id: string
  email: string
  codeHash: string
  expiresAt: Date
  attempts: number
  consumedAt: Date | null
  createdAt: Date | null
}

function toOtpRecord(r: OtpRowLike): OtpRecord {
  return {
    id: r.id,
    email: r.email,
    codeHash: r.codeHash,
    expiresAt: r.expiresAt,
    attempts: r.attempts,
    consumedAt: r.consumedAt,
    createdAt: r.createdAt ?? new Date(),
  }
}

/** A single `role` column expands to the role set the session carries (currently just that role). */
function rolesFor(role: Role): Role[] {
  return [role]
}
