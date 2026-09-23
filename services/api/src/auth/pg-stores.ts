import { randomUUID } from "node:crypto"
import { and, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm"
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
import {
  avatarClaimQuery,
  avatarMediaRefOrThrow,
  type AvatarMediaRow,
} from "../services/avatar-media.js"
import { userUploader } from "../services/media-uploader.js"
import { enqueueWaitlistPromotion } from "../services/host/waitlist-promotion.js"
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

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0]

interface TransferredEvent extends Record<string, unknown> {
  cleanup_id: string
  new_organizer: string
  title: string
}

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

  constructor(
    private readonly db: Db,
    opts: PgUserStoreOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date())
    this.certificateObjects = opts.certificateObjects
    this.logger = opts.logger
    this.notifier = opts.notifier
    this.jobs = opts.jobs
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
          .where(and(eq(users.id, id), isNull(users.deletedAt)))
          .returning()
      })
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
    if (input.primaryOrganizationId !== undefined) {
      if (input.primaryOrganizationId !== null) {
        const member = await this.db.execute<{ one: number }>(sql`
          SELECT 1 AS one
          FROM organization_members m
          JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = ${id}
            AND m.organization_id = ${input.primaryOrganizationId}
            AND o.deleted_at IS NULL
            AND o.suspended_at IS NULL
          LIMIT 1
        `)
        if (member.length === 0) {
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

  private async transferHostedEvents(tx: DbTransaction, id: string): Promise<TransferredEvent[]> {
    const toOrgOwner = await tx.execute<TransferredEvent>(sql`
      WITH candidate AS (
        SELECT c.id AS cleanup_id, om.user_id AS new_organizer
        FROM cleanups c
        JOIN organization_members om
          ON om.organization_id = c.organization_id AND om.role = 'owner'
        JOIN organizations o ON o.id = om.organization_id AND o.deleted_at IS NULL
        JOIN users u ON u.id = om.user_id AND u.deleted_at IS NULL
        WHERE c.organizer_user_id = ${id}
          AND c.status <> 'cancelled' AND c.ends_at > now()
          AND om.user_id <> ${id}
      ), moved AS (
        UPDATE cleanups c SET organizer_user_id = candidate.new_organizer
        FROM candidate WHERE c.id = candidate.cleanup_id
        RETURNING c.id AS cleanup_id, candidate.new_organizer
      ), seated AS (
        INSERT INTO cleanup_members (cleanup_id, user_id, role)
        SELECT cleanup_id, new_organizer, 'organizer' FROM moved
        ON CONFLICT (cleanup_id, user_id) DO UPDATE SET role = 'organizer'
        RETURNING cleanup_id
      )
      SELECT m.cleanup_id, m.new_organizer, c.title
      FROM moved m JOIN cleanups c ON c.id = m.cleanup_id
    `)

    const toCohost = await tx.execute<TransferredEvent>(sql`
      WITH candidate AS (
        SELECT DISTINCT ON (c.id) c.id AS cleanup_id, m.user_id AS new_organizer
        FROM cleanups c
        JOIN cleanup_members m ON m.cleanup_id = c.id AND m.role = 'cohost'
        JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
        WHERE c.organizer_user_id = ${id} AND c.status <> 'cancelled' AND c.ends_at > now()
        ORDER BY c.id, m.joined_at ASC NULLS LAST, m.user_id ASC
      ), moved AS (
        UPDATE cleanups c SET organizer_user_id = candidate.new_organizer
        FROM candidate WHERE c.id = candidate.cleanup_id
        RETURNING c.id AS cleanup_id, candidate.new_organizer
      ), seated AS (
        UPDATE cleanup_members m SET role = 'organizer'
        FROM moved
        WHERE m.cleanup_id = moved.cleanup_id AND m.user_id = moved.new_organizer
        RETURNING m.cleanup_id
      )
      SELECT m.cleanup_id, m.new_organizer, c.title
      FROM moved m JOIN cleanups c ON c.id = m.cleanup_id
    `)

    const moved = [...toOrgOwner, ...toCohost]
    for (const row of moved) {
      await tx.execute(sql`
        INSERT INTO audit_log (actor_id, action, target, meta)
        VALUES (
          ${id},
          'event.host_transferred',
          ${`cleanup:${row.cleanup_id}`},
          jsonb_build_object('newOrganizerId', ${row.new_organizer}::text)
        )
      `)
    }

    await tx.execute(sql`
      UPDATE cleanup_members SET role = 'member'
      WHERE user_id = ${id} AND role = 'organizer'
        AND cleanup_id IN (SELECT id FROM cleanups WHERE organizer_user_id <> ${id})
    `)

    await tx.execute(sql`
      WITH held AS (
        SELECT cleanup_id, role FROM cleanup_members
        WHERE user_id = ${id} AND role IN ('cohost', 'staff', 'coordinator')
      ), demoted AS (
        UPDATE cleanup_members m SET role = 'member'
        FROM held h
        WHERE m.cleanup_id = h.cleanup_id AND m.user_id = ${id}
        RETURNING m.cleanup_id
      )
      INSERT INTO audit_log (actor_id, action, target, meta)
      SELECT NULL::uuid,
             'event.team_role_changed',
             'cleanup:' || h.cleanup_id,
             jsonb_build_object('targetUserId', ${id}::text, 'from', h.role, 'to', 'member')
      FROM held h
    `)
    return moved
  }

  private async releaseOrganizations(tx: DbTransaction, id: string): Promise<void> {
    await tx.execute(sql`
      SELECT o.id FROM organizations o
      WHERE EXISTS (
        SELECT 1 FROM organization_members om
        WHERE om.organization_id = o.id AND om.user_id = ${id} AND om.role = 'owner'
      )
      ORDER BY o.id
      FOR UPDATE
    `)
    const owned = await tx.execute<{ organization_id: string }>(sql`
      UPDATE organization_members SET role = 'admin'
      WHERE user_id = ${id} AND role = 'owner'
      RETURNING organization_id
    `)
    const ownedOrgIds = owned.map((row) => row.organization_id)
    if (ownedOrgIds.length > 0) {
      await tx.execute(sql`
        UPDATE organization_members t SET role = 'owner'
        FROM (
          SELECT DISTINCT ON (om.organization_id) om.organization_id, om.user_id
          FROM organization_members om
          JOIN users u ON u.id = om.user_id AND u.deleted_at IS NULL
          WHERE ${inArray(sql`om.organization_id`, ownedOrgIds)}
            AND om.role = 'admin' AND om.user_id <> ${id}
          ORDER BY om.organization_id, om.joined_at ASC, om.user_id ASC
        ) pick
        WHERE t.organization_id = pick.organization_id AND t.user_id = pick.user_id
      `)
    }
    await tx.execute(sql`DELETE FROM organization_members WHERE user_id = ${id}`)
    // A pending invite must not outlive the admin who sent it (accept re-checks the inviter too, but a
    // revoked row keeps it out of every inbox); one addressed to the closed account can never be accepted.
    await tx.execute(sql`
      WITH revoked AS (
        UPDATE organization_invites
        SET status = 'revoked', revoked_at = now()
        WHERE status = 'pending' AND (invited_by = ${id} OR user_id = ${id})
        RETURNING id, organization_id
      )
      INSERT INTO audit_log (actor_id, action, target, meta)
      SELECT ${id}::uuid, 'org.invite_revoked', 'organization:' || organization_id,
             jsonb_build_object('inviteId', id, 'reason', 'account_deleted')
      FROM revoked
    `)
    if (ownedOrgIds.length > 0) {
      const orphaned = await tx.execute<{ id: string }>(sql`
        UPDATE organizations SET deleted_at = now(), updated_at = now()
        WHERE ${inArray(sql`id`, ownedOrgIds)} AND deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM organization_members ow
            WHERE ow.organization_id = organizations.id AND ow.role = 'owner'
          )
        RETURNING id
      `)
      const orphanedOrgIds = orphaned.map((row) => row.id)
      if (orphanedOrgIds.length > 0) {
        await tx.execute(sql`
          UPDATE cleanups SET organization_id = NULL
          WHERE ${inArray(sql`organization_id`, orphanedOrgIds)}
        `)
      }
    }
    await tx.execute(sql`
      UPDATE cleanup_team_invites
      SET status = 'revoked', invited_email = NULL, email_scrubbed_at = now()
      WHERE status = 'pending' AND (invited_user_id = ${id} OR invited_by = ${id})
    `)
  }

  private async scrubAttendeeContributions(tx: DbTransaction, id: string): Promise<string[]> {
    // Waitlist and ticket-type rows before registrations, the order applyBanIn and the waitlist sweep
    // take, so an erasure racing a ban on one of the user's events cannot deadlock with it.
    const released = await tx.execute<{ id: string }>(sql`
      WITH cancelled_waitlist AS (
        UPDATE cleanup_waitlist SET status = 'cancelled'
         WHERE user_id = ${id} AND status IN ('waiting', 'offered')
        RETURNING ticket_type_id, party_size, offered_at
      ), releases AS (
        SELECT ticket_type_id, sum(party_size)::int AS seats
          FROM cancelled_waitlist
         WHERE offered_at IS NOT NULL
         GROUP BY ticket_type_id
      )
      UPDATE cleanup_ticket_types t
         SET reserved_seats = GREATEST(t.reserved_seats - r.seats, 0),
             updated_at = now()
        FROM releases r
       WHERE t.id = r.ticket_type_id
      RETURNING t.id
    `)
    await tx.execute(sql`
      UPDATE cleanup_registrations SET host_note = NULL
       WHERE user_id = ${id} AND host_note IS NOT NULL
    `)
    await tx.execute(sql`
      UPDATE cleanup_registration_seats s
         SET attendee_name = NULL
        FROM cleanup_registrations r
       WHERE s.registration_id = r.id AND r.user_id = ${id} AND s.attendee_name IS NOT NULL
    `)
    await tx.execute(sql`
      UPDATE cleanup_answers a
         SET value_text = NULL, value_json = NULL, scrubbed_at = now()
        FROM cleanup_registrations r
       WHERE a.registration_id = r.id AND r.user_id = ${id} AND a.scrubbed_at IS NULL
    `)
    await tx.execute(sql`
      UPDATE donations
         SET user_id = NULL,
             profile_unlinked_at = COALESCE(profile_unlinked_at, now()),
             donor_email = CASE WHEN charged_at IS NULL THEN NULL ELSE donor_email END,
             donor_name = CASE WHEN charged_at IS NULL THEN NULL ELSE donor_name END
       WHERE user_id = ${id}
    `)
    return released.map((row) => row.id)
  }

  private async runErasure(id: string): Promise<UserRecord> {
    const erasure = await this.db.transaction(async (tx) => {
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
      // Revocation commits with the tombstone: if these ran after commit, a failure between the two would
      // leave a deleted account whose tokens still authenticate and whose devices still get pushes.
      await tx.delete(sessions).where(eq(sessions.userId, id))
      await tx.delete(pushTokens).where(eq(pushTokens.userId, id))
      await tx.delete(notifications).where(eq(notifications.userId, id))
      await tx
        .update(reports)
        .set({ visibility: "hidden" })
        .where(and(eq(reports.reporterUserId, id), eq(reports.visibility, "public")))
      await this.releaseOrganizations(tx, id)
      const moved = await this.transferHostedEvents(tx, id)
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
      const releasedTicketTypeIds = await this.scrubAttendeeContributions(tx, id)
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

      const verificationMedia = await tx.execute<{
        r2_key: string
        served_key: string | null
        thumb_key: string | null
      }>(sql`
        DELETE FROM media_assets
        WHERE purpose = 'verification'
          AND id IN (
            SELECT (doc->>'mediaId')::uuid
            FROM user_verification uv,
                 jsonb_array_elements(uv.documents) AS doc
            WHERE uv.user_id = ${id} AND doc->>'mediaId' IS NOT NULL
          )
        RETURNING r2_key, served_key, thumb_key
      `)
      await tx.execute(sql`
        UPDATE user_verification
        SET note = NULL, rejection_reason = NULL, documents = '[]'::jsonb, updated_at = now()
        WHERE user_id = ${id}
      `)

      const objectKeys = [
        ...certificates.map((c) => c.r2Key),
        ...verificationMedia.flatMap((m) =>
          [m.r2_key, m.served_key, m.thumb_key].filter((k): k is string => k !== null),
        ),
      ]
      return { record: toUserRecord(r), objectKeys, moved, releasedTicketTypeIds }
    })

    await this.notifyNewOrganizers(erasure.moved)
    await enqueueWaitlistPromotion(this.jobs, erasure.releasedTicketTypeIds, this.logger)

    for (const key of erasure.objectKeys) {
      if (this.certificateObjects === undefined) {
        this.logger?.warn({ userId: id, key }, "erasure object not deleted: no object store wired")
        continue
      }
      try {
        await this.certificateObjects.delete(key)
      } catch (err) {
        this.logger?.warn({ err, userId: id, key }, "erasure object delete failed")
      }
    }
    return erasure.record
  }

  private async notifyNewOrganizers(moved: readonly TransferredEvent[]): Promise<void> {
    if (this.notifier === undefined) return
    for (const row of moved) {
      try {
        await this.notifier.createNotification(row.new_organizer, {
          type: "cleanup_role",
          titleKey: "notification.cleanup_role.promoted.title",
          bodyKey: "notification.cleanup_role.promoted.body",
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

const ERASURE_HANDLE_RETRIES = 5

const PG_UNIQUE_VIOLATION = "23505"

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  )
}
