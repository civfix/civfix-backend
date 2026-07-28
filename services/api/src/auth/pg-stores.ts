
import { randomUUID } from "node:crypto"
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm"
import type { Db } from "../db/client.js"
import {
  cleanups,
  emailOtps,
  mediaAssets,
  oauthIdentities,
  reports,
  serviceHoursCertificates,
  sessions,
  users,
} from "../db/schema/index.js"
import { AppError, DELETED_USER_LABEL, SOCIAL_PLATFORMS, type Role, type SocialLinks } from "@civfix/shared"
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
      // sessions.created_at is NOT NULL as of drizzle/0058_sessions_created_at.sql (it backfills the legacy
      // NULL rows from last_seen_at), and the absolute 90-day ceiling (M3) is measured FROM it. This
      // fallback is KEPT as belt-and-braces: the production deploy does not auto-migrate (see the operator
      // runbook), so a box running this code against the pre-0058 schema must still fail closed. A NULL
      // reads as the epoch: already past the ceiling (the holder re-authenticates once). Falling back to
      // last_seen_at instead would make the ceiling unreachable — last_seen_at is bumped by every
      // sliding-expiry write, so an active legacy session was capped from its own last activity and never
      // expired, which is the unbounded-sliding hole M3 closes.
      createdAt: r.createdAt ?? new Date(0),
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
    const deleted = await this.db
      .delete(sessions)
      .where(eq(sessions.userId, userId))
      .returning({ id: sessions.id })
    return deleted.map((r) => r.id)
  }
}

/**
 * Structural slice of the storage adapter, declared locally so the auth layer never imports a service
 * (the same posture `CertificateStorage` takes in certificate-service.ts). Account erasure needs exactly
 * one verb: drop the rendered certificate PDF that prints the erased holder's legal name.
 */
export interface ErasureObjectStore {
  delete(key: string): Promise<void>
}

/** Same shape as `OtpLogger`; re-declared rather than imported for the same reason. */
export interface ErasureLogger {
  warn(obj: unknown, msg?: string): void
}

export interface PgUserStoreOptions {
  now?: () => Date
  /**
   * Wired in production by `buildAuthServicesFromContainer`. When ABSENT the row-level scrub still runs
   * (it is transactional with the tombstone); only the best-effort object delete is skipped, and that
   * skip is LOGGED rather than silent — an unwired deleter means erased holders' PDFs accumulate in R2.
   */
  certificateObjects?: ErasureObjectStore
  logger?: ErasureLogger
}

export class PgUserStore implements UserStore {
  private readonly now: () => Date
  private readonly certificateObjects: ErasureObjectStore | undefined
  private readonly logger: ErasureLogger | undefined

  constructor(
    private readonly db: Db,
    opts: PgUserStoreOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date())
    this.certificateObjects = opts.certificateObjects
    this.logger = opts.logger
  }

  async findById(id: string): Promise<UserRecord | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1)
    const r = rows[0]
    return r ? toUserRecord(r) : null
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1)
    const r = rows[0]
    return r ? toUserRecord(r) : null
  }

  async create(email: string | null, input: CreateUserInput): Promise<UserRecord> {
    const normalizedEmail = email === null ? null : email.toLowerCase()
    const id = randomUUID()
    const inserted = await this.db
      .insert(users)
      .values({
        id,
        handle: input.handle ?? generatePlaceholderHandle(id),
        displayName: input.displayName,
        role: input.role ?? "citizen",
        email: normalizedEmail,
        emailVerified: email !== null && (input.emailVerified ?? false),
        avatarUrl: input.avatarUrl ?? null,
        ...(input.profileComplete !== undefined ? { profileComplete: input.profileComplete } : {}),
      })
      .onConflictDoNothing({ target: users.email, where: sql`${users.email} is not null` })
      .returning()
    const row = inserted[0]
    if (row) return toUserRecord(row)

    if (normalizedEmail !== null) {
      const existing = await this.findByEmail(normalizedEmail)
      if (existing) return existing
    }
    throw new Error("PgUserStore.create: insert returned no row")
  }

  async findByHandle(handle: string): Promise<UserRecord | null> {
    const rows = await this.db.select().from(users).where(eq(users.handle, handle)).limit(1)
    const r = rows[0]
    return r ? toUserRecord(r) : null
  }

  async updateProfile(id: string, input: UpdateProfileInput): Promise<UserRecord> {
    const current = await this.findById(id)
    if (!current) throw AppError.notFound("User not found.")

    const set: Partial<typeof users.$inferInsert> = {
      displayName: input.displayName,
      profileComplete: true,
    }

    if (handleChanged(current.handle, input.handle)) {
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
    if (input.bio !== undefined) set.bio = input.bio === "" ? null : input.bio
    if (input.avatarUploadId !== undefined) {
      const media = await this.db
        .select({ id: mediaAssets.id, r2Key: mediaAssets.r2Key })
        .from(mediaAssets)
        .where(eq(mediaAssets.uploadId, input.avatarUploadId))
        .limit(1)
      if (media[0]) {
        set.avatarMediaId = media[0].id
        if (input.presignAvatar) {
          set.avatarUrl = await input.presignAvatar(media[0].r2Key)
        }
      }
    }
    if (input.socialLinks !== undefined) {
      const links = input.socialLinks
      const clean: SocialLinks = {}
      if (links) {
        for (const platform of SOCIAL_PLATFORMS) {
          const value = links[platform]
          if (typeof value === "string" && value.length > 0) clean[platform] = value
        }
      }
      set.socialLinks = Object.keys(clean).length > 0 ? clean : null
    }
    let updated: (typeof users.$inferSelect)[]
    try {
      // Never write a profile onto a TOMBSTONE: a soft-deleted row would otherwise take the display
      // name/handle/bio/avatar and profile_complete of whoever still held a session, resurrecting a
      // deleted identity's public surface. Unreachable today (deletion revokes every session), so this
      // is the structural guard, not a fix for a live path — and the empty result falls into the 404
      // below, the same answer a caller gets for an id that never existed.
      updated = await this.db
        .update(users)
        .set(set)
        .where(and(eq(users.id, id), isNull(users.deletedAt)))
        .returning()
    } catch (err) {
      if (isUniqueViolation(err)) throw AppError.conflict("That username is taken.")
      throw err
    }
    const r = updated[0]
    if (!r) throw AppError.notFound("User not found.")
    return toUserRecord(r)
  }

  async setRole(id: string, role: Role): Promise<UserRecord> {
    const updated = await this.db.update(users).set({ role }).where(eq(users.id, id)).returning()
    const r = updated[0]
    if (!r) throw new Error("PgUserStore.setRole: user not found")
    return toUserRecord(r)
  }

  async updateSettings(id: string, input: UpdateSettingsInput): Promise<UserRecord> {
    const set: Partial<typeof users.$inferInsert> = {}
    if (input.allowDirectMessages !== undefined) set.allowDirectMessages = input.allowDirectMessages
    if (input.locale !== undefined) set.locale = input.locale
    // Only an EXPLICIT boolean is ever written; an omitted field leaves the tri-state alone, so a user
    // who has never touched the toggle keeps the NULL "never chosen" state through every other settings
    // write.
    if (input.showVolunteerHours !== undefined) set.showVolunteerHours = input.showVolunteerHours
    const updated = await this.db.update(users).set(set).where(eq(users.id, id)).returning()
    const r = updated[0]
    if (!r) throw new Error("PgUserStore.updateSettings: user not found")
    return toUserRecord(r)
  }

  /**
   * SOFT delete + anonymize (docs/erasure-behavior.md is the source of record).
   *
   * The `users` scrub, the content de-listing and the CERTIFICATE scrub all commit together: a partial
   * erasure that tombstones the account but leaves the one unscrubbed copy of the erased legal name
   * behind is exactly the failure this transaction exists to prevent. The R2 objects are dropped AFTER
   * the commit (best-effort) — deleting them inside would destroy live documents if the transaction then
   * rolled back.
   */
  async softDeleteAndAnonymize(id: string): Promise<UserRecord> {
    const { record, certificateKeys } = await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(users)
        .set({
          deletedAt: sql`COALESCE(${users.deletedAt}, now())`,
          allowDirectMessages: false,
          email: null,
          emailVerified: false,
          displayName: DELETED_USER_LABEL,
          handle: generatePlaceholderHandle(id),
          bio: null,
          avatarUrl: null,
          avatarMediaId: null,
          socialLinks: null,
        })
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

      /**
       * `service_hours_certificates` is the ONLY table that keeps a FROZEN COPY of the holder's legal
       * name (`holder_name`/`holder_handle`) plus an itemised record of where they were and when
       * (`snapshot` — the whole rendered TranscriptModel: per-event titles, jurisdictions, credited-by
       * names). Nulling `users.display_name` does not reach it, so an erased account used to leave its
       * one unscrubbed identity copy here.
       *
       * REVOKE rather than DELETE the rows (0064's banner rule): the code must keep answering "issued,
       * then revoked" instead of "no such code" for whoever is holding the paper. `code`, `issued_at`,
       * the totals and `document_sha256` are KEPT so `verify` can still answer; everything that names
       * the person is blanked. `revoked_reason = 'account_closed'` is the exact reason the verify
       * projection already synthesises for a tombstoned holder, so the stored row and the wire answer
       * now agree.
       *
       * COALESCE keeps it idempotent (a repeat delete does not move an existing revocation timestamp)
       * and preserves a holder's own earlier "holder" revocation reason. Already-revoked rows are
       * included on purpose: their PII is just as much PII, and their object may still exist if the
       * best-effort delete at revoke time failed.
       */
      const certificates = await tx
        .update(serviceHoursCertificates)
        .set({
          revokedAt: sql`COALESCE(${serviceHoursCertificates.revokedAt}, now())`,
          revokedReason: sql`COALESCE(${serviceHoursCertificates.revokedReason}, 'account_closed')`,
          // NOT NULL, so it takes the same tombstone label the users row does rather than an empty string.
          holderName: DELETED_USER_LABEL,
          holderHandle: null,
          snapshot: {},
        })
        .where(eq(serviceHoursCertificates.userId, id))
        .returning({ r2Key: serviceHoursCertificates.r2Key })

      return { record: toUserRecord(r), certificateKeys: certificates.map((c) => c.r2Key) }
    })

    // Post-commit and best-effort, mirroring CertificateService.revoke's own delete: an orphaned 40 KB
    // PDF is a rounding error, but a throw here would turn a COMPLETED erasure into a 500 the client
    // reads as "deletion failed" (users.routes' deleteAccount makes the same trade for its cleanups).
    for (const key of certificateKeys) {
      if (this.certificateObjects === undefined) {
        this.logger?.warn(
          { userId: id, key },
          "certificate object not deleted on account erasure: no object store wired",
        )
        continue
      }
      try {
        await this.certificateObjects.delete(key)
      } catch (err) {
        this.logger?.warn({ err, userId: id, key }, "certificate object delete failed on erasure")
      }
    }
    return record
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
    await this.db
      .insert(oauthIdentities)
      .values({ userId, provider, providerUserId })
      .onConflictDoUpdate({
        target: [oauthIdentities.provider, oauthIdentities.providerUserId],
        set: { userId },
      })
  }

  async deleteAllForUser(userId: string): Promise<void> {
    await this.db.delete(oauthIdentities).where(eq(oauthIdentities.userId, userId))
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

  async markConsumed(id: string, at: Date): Promise<boolean> {
    // Conditional on consumed_at IS NULL so the RETURNING row identifies the single winner among
    // concurrent verifies of the same code (see the OtpStore doc).
    const claimed = await this.db
      .update(emailOtps)
      .set({ consumedAt: at })
      .where(and(eq(emailOtps.id, id), isNull(emailOtps.consumedAt)))
      .returning({ id: emailOtps.id })
    return claimed.length > 0
  }
}

export class PgAuthStores implements AuthStores {
  readonly sessions: SessionStore
  readonly users: UserStore
  readonly oauth: OAuthIdentityStore
  readonly otps: OtpStore

  /**
   * `opts` is forwarded to `PgUserStore` only. It carries the erasure object store (the certificate PDF
   * deleter) so account deletion can reach R2; omitting it degrades to a row-only scrub with a warning.
   */
  constructor(db: Db, opts: PgUserStoreOptions = {}) {
    this.sessions = new PgSessionStore(db)
    this.users = new PgUserStore(db, opts)
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
  showVolunteerHours: boolean | null
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
    // Carried through as-is: NULL means "never chosen" and must NOT be coerced to a boolean here (see
    // UserRecord). toUserDTO decides whether to put it on the wire at all.
    showVolunteerHours: r.showVolunteerHours,
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

function rolesFor(role: Role): Role[] {
  return [role]
}

const PG_UNIQUE_VIOLATION = "23505"

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  )
}
