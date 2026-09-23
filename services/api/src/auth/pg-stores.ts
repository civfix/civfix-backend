import { randomUUID } from "node:crypto"
import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm"
import type { Db } from "../db/client.js"
import {
  cleanups,
  emailOtps,
  notifications,
  oauthIdentities,
  posts,
  pushTokens,
  reports,
  serviceHoursCertificates,
  sessions,
  userModeration,
  users,
} from "../db/schema/index.js"
import {
  AppError,
  DELETED_USER_LABEL,
  SOCIAL_PLATFORMS,
  type Role,
  type SocialLinks,
} from "@civfix/shared"
import type { Jobs } from "@civfix/shared/interfaces"
import { decideHandleWrite, handleChanged } from "./handle-policy.js"
import { avatarMediaRefOrThrow } from "../services/avatar-media.js"
import {
  avatarClaimQuery,
  type AvatarMediaRow,
} from "../services/media-claim-repository.drizzle.js"
import { userUploader } from "../services/media-uploader.js"
import { enqueueWaitlistPromotion } from "../services/host/waitlist-promotion.js"
import {
  makeDrizzleOrganizationMembershipRepository,
  type OrganizationMembershipRepository,
} from "../services/host/organization-membership-repository.drizzle.js"
import {
  makeDrizzleErasureRepository,
  type DbTransaction,
  type ErasureRepository,
  type TransferredEvent,
} from "../services/erasure-repository.drizzle.js"
import type { NotificationService } from "../services/notification-service.js"
import {
  EmailTakenError,
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
  PRIMARY_ORGANIZATION_NOT_A_MEMBER,
  type UpdateSettingsInput,
  type UserRecord,
  type UserStore,
} from "./stores.js"
import { isUniqueViolation } from "../db/pg-errors.js"

const ERASURE_HANDLE_RETRIES = 5

const HOST_TRANSFER_TITLE_KEY = "notification.cleanup_role.promoted.title"

const HOST_TRANSFER_BODY_KEY = "notification.cleanup_role.promoted.body"

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
        accountStatus: userModeration.accountStatus,
        createdAt: sessions.createdAt,
        expiresAt: sessions.expiresAt,
        lastSeenAt: sessions.lastSeenAt,
        userAgent: sessions.userAgent,
        ip: sessions.ip,
      })
      .from(sessions)
      .innerJoin(users, and(eq(users.id, sessions.userId), isNull(users.deletedAt)))
      .leftJoin(userModeration, eq(userModeration.userId, sessions.userId))
      .where(eq(sessions.id, hash))
      .limit(1)

    const r = rows[0]
    if (!r) return null
    return {
      id: r.id,
      userId: r.userId,
      roles: rolesFor(r.role),
      accountStatus: r.accountStatus ?? "active",
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

export type ErasureNotifier = Pick<NotificationService, "createNotification">

export interface PgUserStoreOptions {
  now?: () => Date
  certificateObjects?: ErasureObjectStore
  logger?: ErasureLogger
  notifier?: ErasureNotifier
  jobs?: Jobs
}

export class PgUserStore implements UserStore {
  private readonly now: () => Date
  private readonly certificateObjects: ErasureObjectStore | undefined
  private readonly logger: ErasureLogger | undefined
  private readonly notifier: ErasureNotifier | undefined
  private readonly jobs: Jobs | undefined
  private readonly organizations: OrganizationMembershipRepository
  private readonly erasure: ErasureRepository

  constructor(
    private readonly db: Db,
    opts: PgUserStoreOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date())
    this.certificateObjects = opts.certificateObjects
    this.logger = opts.logger
    this.notifier = opts.notifier
    this.jobs = opts.jobs
    this.organizations = makeDrizzleOrganizationMembershipRepository(db)
    this.erasure = makeDrizzleErasureRepository()
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

    if (normalizedEmail !== null && input.onEmailConflict === "reject") {
      throw new EmailTakenError()
    }
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

  updateProfile(id: string, input: UpdateProfileInput): Promise<UserRecord> {
    return this.writeProfile(id, input, true)
  }

  private async writeProfile(
    id: string,
    input: UpdateProfileInput,
    retryOnLostRename: boolean,
  ): Promise<UserRecord> {
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
    if (input.donationUrl !== undefined) {
      set.donationUrl = input.donationUrl === "" ? null : input.donationUrl
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
    // The cooldown was decided on the handle read above; pinning the write to that handle means a
    // concurrent rename that landed first makes this one miss, and the retry re-decides on fresh state.
    const renameGuard =
      set.handle === undefined
        ? undefined
        : current.handle === null
          ? isNull(users.handle)
          : eq(users.handle, current.handle)
    const avatarUploadId = input.avatarUploadId
    let updated: (typeof users.$inferSelect)[]
    try {
      updated = await this.db.transaction(async (tx) => {
        if (avatarUploadId !== undefined) {
          const media = avatarMediaRefOrThrow(
            await tx.execute<AvatarMediaRow>(
              avatarClaimQuery(sql, avatarUploadId, { uploader: userUploader(id), userId: id }),
            ),
          )
          set.avatarMediaId = media.id
          if (input.presignAvatar && media.servedKey !== null) {
            set.avatarUrl = await input.presignAvatar(media.servedKey)
          }
        }
        return tx
          .update(users)
          .set(set)
          .where(and(eq(users.id, id), isNull(users.deletedAt), renameGuard))
          .returning()
      })
    } catch (err) {
      if (isUniqueViolation(err)) throw AppError.conflict("That username is taken.")
      throw err
    }
    const r = updated[0]
    if (!r) {
      if (renameGuard !== undefined && retryOnLostRename) return this.writeProfile(id, input, false)
      throw AppError.notFound("User not found.")
    }
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
    if (input.primaryOrganizationId !== undefined) {
      if (input.primaryOrganizationId !== null) {
        if (!(await this.organizations.isActiveMember(id, input.primaryOrganizationId))) {
          throw AppError.validation({
            primaryOrganizationId: PRIMARY_ORGANIZATION_NOT_A_MEMBER,
          })
        }
      }
      set.primaryOrganizationId = input.primaryOrganizationId
    }
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
    const erasure = await this.db.transaction(async (tx) => {
      const tombstoned = await this.tombstoneUser(tx, id)
      // Revocation commits with the tombstone: if these ran after commit, a failure between the two would
      // leave a deleted account whose tokens still authenticate and whose devices still get pushes.
      await this.revokeSessionsAndDevices(tx, id)
      await tx
        .update(reports)
        .set({ visibility: "hidden" })
        .where(and(eq(reports.reporterUserId, id), eq(reports.visibility, "public")))
      await this.erasure.releaseOrganizations(tx, id)
      const moved = await this.erasure.transferHostedEvents(tx, id)
      await this.cancelRemainingHostedEvents(tx, id)
      const releasedTicketTypeIds = await this.erasure.scrubAttendeeContributions(tx, id)
      await tx
        .update(posts)
        .set({ visibility: "hidden" })
        .where(and(eq(posts.authorId, id), eq(posts.visibility, "public")))
      const certificateKeys = await this.revokeCertificates(tx, id)
      await this.erasure.scrubModerationSnapshots(tx, id)
      const verificationKeys = await this.erasure.purgeVerificationDocuments(tx, id)
      return {
        record: toUserRecord(tombstoned),
        objectKeys: [...certificateKeys, ...verificationKeys],
        moved,
        releasedTicketTypeIds,
      }
    })

    await this.notifyNewOrganizers(erasure.moved)
    await enqueueWaitlistPromotion(this.jobs, erasure.releasedTicketTypeIds, this.logger)
    await this.deleteErasedObjects(id, erasure.objectKeys)
    return erasure.record
  }

  private async tombstoneUser(tx: DbTransaction, id: string): Promise<typeof users.$inferSelect> {
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
        donationUrl: null,
        lastActivityGeom: null,
        lastActivityAt: null,
        primaryOrganizationId: null,
      })
      .where(eq(users.id, id))
      .returning()
    const r = updated[0]
    if (!r) throw new Error("PgUserStore.softDeleteAndAnonymize: user not found")
    return r
  }

  private async revokeSessionsAndDevices(tx: DbTransaction, id: string): Promise<void> {
    await tx.delete(sessions).where(eq(sessions.userId, id))
    await tx.delete(pushTokens).where(eq(pushTokens.userId, id))
    await tx.delete(notifications).where(eq(notifications.userId, id))
  }

  private async cancelRemainingHostedEvents(tx: DbTransaction, id: string): Promise<void> {
    await tx
      .update(cleanups)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(cleanups.organizerUserId, id),
          ne(cleanups.status, "cancelled"),
          gt(cleanups.endsAt, new Date()),
        ),
      )
  }

  private async revokeCertificates(tx: DbTransaction, id: string): Promise<string[]> {
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
    return certificates.map((c) => c.r2Key)
  }

  private async deleteErasedObjects(userId: string, keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      if (this.certificateObjects === undefined) {
        this.logger?.warn({ userId, key }, "erasure object not deleted: no object store wired")
        continue
      }
      try {
        await this.certificateObjects.delete(key)
      } catch (err) {
        this.logger?.warn({ err, userId, key }, "erasure object delete failed")
      }
    }
  }

  private async notifyNewOrganizers(moved: readonly TransferredEvent[]): Promise<void> {
    if (this.notifier === undefined) return
    for (const row of moved) {
      try {
        await this.notifier.createNotification(row.new_organizer, {
          type: "cleanup_role",
          titleKey: HOST_TRANSFER_TITLE_KEY,
          bodyKey: HOST_TRANSFER_BODY_KEY,
          vars: { title: row.title },
          link: `/cleanups/${row.cleanup_id}`,
        })
      } catch (err) {
        this.logger?.warn(
          { err, cleanupId: row.cleanup_id, newOrganizerId: row.new_organizer },
          "erasure host transfer notification failed (suppressed)",
        )
      }
    }
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

  async hasIdentityForUser(userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: oauthIdentities.id })
      .from(oauthIdentities)
      .where(eq(oauthIdentities.userId, userId))
      .limit(1)
    return rows.length > 0
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
  primaryOrganizationId: string | null
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
    primaryOrganizationId: r.primaryOrganizationId,
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
