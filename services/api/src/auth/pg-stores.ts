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

import { randomUUID } from "node:crypto"
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm"
import type { Db } from "../db/client.js"
import {
  cleanups,
  emailOtps,
  mediaAssets,
  oauthIdentities,
  reports,
  sessions,
  users,
} from "../db/schema/index.js"
import { AppError, type Role } from "@civfix/shared"
import { decideHandleWrite, handleChanged } from "./handle-policy.js"
import {
  generatePlaceholderHandle,
  type AuthStores,
  type CreateUserInput,
  type OAuthIdentityRecord,
  type OAuthIdentityStore,
  type OtpInsert,
  type OtpRecord,
  type OtpStore,
  type SessionInsert,
  type SessionRecord,
  type SessionStore,
  type UpdateProfileInput,
  type UpdateSettingsInput,
  type UserRecord,
  type UserStore,
} from "./stores.js"

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

/**
 * Reads/writes the real `users.email` column (CITEXT, partial-unique when non-null). find-or-create
 * by email resolves directly off that column, so `oauth_identities` is now ONLY for apple/google
 * provider links and no longer carries a synthetic "email" pseudo-provider row.
 */
export class PgUserStore implements UserStore {
  private readonly now: () => Date

  /** `now` is injectable so tests can drive the rename-cooldown clock deterministically. */
  constructor(
    private readonly db: Db,
    opts: { now?: () => Date } = {},
  ) {
    this.now = opts.now ?? (() => new Date())
  }

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
    // Generate the id app-side so the placeholder @handle is derived from it deterministically (matches the
    // 0026 backfill: 'user'+12 hex of id). `handle` is NOT NULL, so every new account must carry one; the
    // user picks their real handle in first-run registration. handle_changed_at stays null (the column
    // default), so the placeholder choice is never treated as a rename.
    const id = randomUUID()
    const inserted = await this.db
      .insert(users)
      .values({
        id,
        // Explicit handle for server-provisioned accounts (reviewer bypass); else a placeholder derived
        // from the id. The caller owns reserved/uniqueness for an explicit handle; the unique index backs it.
        handle: input.handle ?? generatePlaceholderHandle(id),
        displayName: input.displayName,
        role: input.role ?? "citizen",
        email: normalizedEmail,
        emailVerified: email !== null && (input.emailVerified ?? false),
        avatarUrl: input.avatarUrl ?? null,
        // profile_complete defaults false (new users finish first-run registration) unless the caller marks
        // the account already set up (reviewer bypass).
        ...(input.profileComplete !== undefined ? { profileComplete: input.profileComplete } : {}),
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
    // Load the current row to read the rename-policy inputs (profile_complete + handle_changed_at). The
    // name/bio editors re-send the CURRENT handle every PUT, so an unchanged handle MUST be a no-op.
    const current = await this.findById(id)
    if (!current) throw AppError.notFound("User not found.")

    const set: Partial<typeof users.$inferInsert> = {
      displayName: input.displayName,
      profileComplete: true,
    }

    if (handleChanged(current.handle, input.handle)) {
      // uniqueness here races the partial-unique index for the rare concurrent-claim case.
      const taken = await this.findByHandle(input.handle)
      const decided = decideHandleWrite({
        current: current.handle,
        submitted: input.handle,
        profileComplete: current.profileComplete,
        handleChangedAt: current.handleChangedAt,
        isTaken: taken !== null && taken.id !== id,
        now: this.now(),
      })
      set.handle = decided.handle
      set.handleChangedAt = decided.handleChangedAt
    }
    // Only touch the bio when the caller supplied it (the bio editor); registration omits it. An empty
    // string clears the bio; trimming/length are already enforced by the shared UpdateProfileRequest.
    if (input.bio !== undefined) set.bio = input.bio === "" ? null : input.bio
    // CANONICALIZE avatar_url ON UPLOAD: when the avatar picker sent a finalized upload id, resolve it to
    // the media row (possessing the finalized id is the capability proof, like the report flow), set
    // avatar_media_id, AND presign the media's r2_key into the canonical public URL persisted in
    // users.avatar_url — the single source of truth every projection reads (no per-request presign). An
    // unknown upload id, or a presign blip, leaves the avatar unchanged rather than failing the whole
    // profile update (a transient R2 error must not block first-run registration).
    if (input.avatarUploadId !== undefined) {
      const media = await this.db
        .select({ id: mediaAssets.id, r2Key: mediaAssets.r2Key })
        .from(mediaAssets)
        .where(eq(mediaAssets.uploadId, input.avatarUploadId))
        .limit(1)
      if (media[0]) {
        set.avatarMediaId = media[0].id
        if (input.presignAvatar) {
          try {
            set.avatarUrl = await input.presignAvatar(media[0].r2Key)
          } catch {
            // Leave avatar_url unchanged; avatar_media_id still points at the processed copy.
          }
        }
      }
    }
    const updated = await this.db.update(users).set(set).where(eq(users.id, id)).returning()
    const r = updated[0]
    if (!r) throw AppError.notFound("User not found.")
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

  /**
   * Update account/privacy settings. Only present fields are written (an empty patch is a harmless
   * no-op that still returns the current row). Currently just the DM toggle.
   */
  async updateSettings(id: string, input: UpdateSettingsInput): Promise<UserRecord> {
    const set: Partial<typeof users.$inferInsert> = {}
    if (input.allowDirectMessages !== undefined) set.allowDirectMessages = input.allowDirectMessages
    if (input.locale !== undefined) set.locale = input.locale
    const updated = await this.db.update(users).set(set).where(eq(users.id, id)).returning()
    const r = updated[0]
    if (!r) throw new Error("PgUserStore.updateSettings: user not found")
    return toUserRecord(r)
  }

  /**
   * Self-service account deletion. SOFT delete: set deleted_at = now() (only when not already set, so a
   * repeat delete keeps the original tombstone time) and turn DMs off, but KEEP display_name/handle/email
   * intact so the admin panel keeps the real identity. The public author projections render "Deleted User"
   * off the deleted_at tombstone; the users row + every content FK to it survive. The route additionally
   * revokes the user's sessions (set deleted_at alone does NOT log a warm session out).
   */
  async softDeleteAndAnonymize(id: string): Promise<UserRecord> {
    // One transaction: tombstone the user AND UNLIST (never delete) the content they authored, since a
    // report is already forwarded to the city and a hard delete would orphan that pipeline item. Reports
    // flip visibility 'public' -> 'hidden' (off the map / search / public detail; the row + city status
    // are kept and the owner is gone). Still-active events ('upcoming' | 'active') flip status ->
    // 'cancelled' (off the map + upcoming lists). Past ('done') events and already hidden/cancelled
    // content are left untouched; anon reports (reporter_user_id NULL) never match.
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(users)
        .set({ deletedAt: sql`COALESCE(${users.deletedAt}, now())`, allowDirectMessages: false })
        .where(eq(users.id, id))
        .returning()
      const r = updated[0]
      if (!r) throw new Error("PgUserStore.softDeleteAndAnonymize: user not found")
      await tx
        .update(reports)
        .set({ visibility: "hidden" })
        .where(and(eq(reports.reporterUserId, id), eq(reports.visibility, "public")))
      await tx
        .update(cleanups)
        .set({ status: "cancelled" })
        .where(and(eq(cleanups.organizerUserId, id), inArray(cleanups.status, ["upcoming", "active"])))
      return toUserRecord(r)
    })
  }
}

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
    // Idempotent UPSERT on the globally-unique (provider, provider_user_id). A bare DO NOTHING would
    // silently no-op when the pair already exists, leaving the identity stranded on whatever user it
    // first pointed at; DO UPDATE re-points user_id so a re-link converges on the intended user.
    await this.db
      .insert(oauthIdentities)
      .values({ userId, provider, providerUserId })
      .onConflictDoUpdate({
        target: [oauthIdentities.provider, oauthIdentities.providerUserId],
        set: { userId },
      })
  }
}

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

interface UserRowLike {
  id: string
  role: Role
  displayName: string
  handle: string | null
  handleChangedAt: Date | null
  email: string | null
  emailVerified: boolean
  avatarUrl: string | null
  profileComplete: boolean
  allowDirectMessages: boolean
  locale: string
  createdAt: Date
  deletedAt: Date | null
}

function toUserRecord(r: UserRowLike): UserRecord {
  return {
    id: r.id,
    role: r.role,
    displayName: r.displayName,
    handle: r.handle,
    handleChangedAt: r.handleChangedAt,
    email: r.email,
    emailVerified: r.emailVerified,
    avatarUrl: r.avatarUrl,
    profileComplete: r.profileComplete,
    allowDirectMessages: r.allowDirectMessages,
    locale: r.locale,
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
