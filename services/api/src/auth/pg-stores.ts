
import { randomUUID } from "node:crypto"
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm"
import type { Db } from "../db/client.js"
import {
  cleanups,
  emailOtps,
  oauthIdentities,
  posts,
  reports,
  serviceHoursCertificates,
  sessions,
  userModeration,
  users,
} from "../db/schema/index.js"
import { AppError, DELETED_USER_LABEL, SOCIAL_PLATFORMS, type Role, type SocialLinks } from "@civfix/shared"
import { decideHandleWrite, handleChanged } from "./handle-policy.js"
import { resolveAvatarMediaOrThrow } from "../services/avatar-media.js"
import {
  generatePlaceholderHandle,
  generateTombstoneHandle,
  type AccountStatus,
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

export interface ErasureObjectStore {
  delete(key: string): Promise<void>
}

export interface ErasureLogger {
  warn(obj: unknown, msg?: string): void
}

export interface PgUserStoreOptions {
  now?: () => Date
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
      const media = await resolveAvatarMediaOrThrow(this.db.$client, input.avatarUploadId, {
        userId: id,
      })
      set.avatarMediaId = media.id
      if (input.presignAvatar) {
        set.avatarUrl = await input.presignAvatar(media.r2Key)
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
    if (input.showVolunteerHours !== undefined) set.showVolunteerHours = input.showVolunteerHours
    if (Object.keys(set).length === 0) {
      const current = await this.findById(id)
      if (!current) throw new Error("PgUserStore.updateSettings: user not found")
      return current
    }
    const updated = await this.db.update(users).set(set).where(eq(users.id, id)).returning()
    const r = updated[0]
    if (!r) throw new Error("PgUserStore.updateSettings: user not found")
    return toUserRecord(r)
  }

  async accountStatus(id: string): Promise<AccountStatus> {
    const rows = await this.db
      .select({ status: userModeration.accountStatus })
      .from(userModeration)
      .where(eq(userModeration.userId, id))
      .limit(1)
    return rows[0]?.status ?? "active"
  }

  async softDeleteAndAnonymize(id: string): Promise<UserRecord> {
    let attempt = 0
    for (;;) {
      try {
        return await this.runErasure(id)
      } catch (err) {
        if (isUniqueViolation(err) && attempt < ERASURE_HANDLE_RETRIES) {
          attempt += 1
          continue
        }
        throw err
      }
    }
  }

  private async runErasure(id: string): Promise<UserRecord> {
    const { record, objectKeys } = await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(users)
        .set({
          deletedAt: sql`COALESCE(${users.deletedAt}, now())`,
          allowDirectMessages: false,
          email: null,
          emailVerified: false,
          displayName: DELETED_USER_LABEL,
          handle: generateTombstoneHandle(),
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
      await tx
        .update(posts)
        .set({ visibility: "hidden" })
        .where(and(eq(posts.authorId, id), eq(posts.visibility, "public")))

      const certificates = await tx
        .update(serviceHoursCertificates)
        .set({
          revokedAt: sql`COALESCE(${serviceHoursCertificates.revokedAt}, now())`,
          revokedReason: sql`COALESCE(${serviceHoursCertificates.revokedReason}, 'account_closed')`,
          holderName: DELETED_USER_LABEL,
          holderHandle: null,
          snapshot: {},
        })
        .where(eq(serviceHoursCertificates.userId, id))
        .returning({ r2Key: serviceHoursCertificates.r2Key })

      await tx.execute(sql`
        UPDATE moderation_items
        SET meta = jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(meta, '{user,name}', to_jsonb(${DELETED_USER_LABEL}::text), false),
              '{user,handle}', to_jsonb(''::text), false),
            '{user,device}', to_jsonb(''::text), false),
          '{user,joined}', to_jsonb(''::text), false)
        WHERE meta->'user'->>'id' = ${id}
      `)
      await tx.execute(sql`
        UPDATE moderation_items
        SET meta = jsonb_set(
          jsonb_set(meta, '{reporter}', to_jsonb(${DELETED_USER_LABEL}::text), false),
          '{desc}', to_jsonb(''::text), false)
        WHERE meta->>'reporterUserId' = ${id}
      `)

      const verificationMedia = await tx.execute<{ r2_key: string }>(sql`
        DELETE FROM media_assets
        WHERE purpose = 'verification'
          AND id IN (
            SELECT (doc->>'mediaId')::uuid
            FROM user_verification uv,
                 jsonb_array_elements(uv.documents) AS doc
            WHERE uv.user_id = ${id} AND doc->>'mediaId' IS NOT NULL
          )
        RETURNING r2_key
      `)
      await tx.execute(sql`
        UPDATE user_verification
        SET note = NULL, rejection_reason = NULL, documents = '[]'::jsonb, updated_at = now()
        WHERE user_id = ${id}
      `)

      const objectKeys = [
        ...certificates.map((c) => c.r2Key),
        ...verificationMedia.map((m) => m.r2_key),
      ]
      return { record: toUserRecord(r), objectKeys }
    })

    for (const key of objectKeys) {
      if (this.certificateObjects === undefined) {
        this.logger?.warn(
          { userId: id, key },
          "erasure object not deleted: no object store wired",
        )
        continue
      }
      try {
        await this.certificateObjects.delete(key)
      } catch (err) {
        this.logger?.warn({ err, userId: id, key }, "erasure object delete failed")
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

const ERASURE_HANDLE_RETRIES = 5

const PG_UNIQUE_VIOLATION = "23505"

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  )
}
