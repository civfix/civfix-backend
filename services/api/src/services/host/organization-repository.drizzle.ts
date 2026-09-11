import type {
  OrganizationInviteRole,
  OrganizationInviteStatus,
  OrganizationMemberRole,
  OrgPaymentsState,
  OrgVerificationKind,
  OrgVerificationStatus,
  SocialLinks,
} from "@civfix/shared"
import { AppError } from "@civfix/shared"
import type postgres from "postgres"
import type { Queryable, Sql } from "../../db/client.js"
import { encodeTimeCursor, isUuid, pageWith, parseTimeCursor } from "../../db/cursor-helpers.js"
import { likeContains } from "../admin/like.js"
import { servedKeyExpr } from "../media-served-key.js"
import { upsertOrgEligibilityEin } from "../payments/eligibility-repository.drizzle.js"
import { normalizeEin } from "../payments/eligibility-sources.js"
import { MEDIA_CLAIM_WINDOW_SEC } from "./event-media.js"
import { mediaBoundElsewhere } from "../media-bindings.js"
import { writeHostAudit } from "./host-audit.js"
import type {
  AcceptOrganizationInviteOutcome,
  DeclineOrganizationInviteOutcome,
  PendingOrganizationInviteRecord,
  AddOrganizationMemberOutcome,
  AdminActorView,
  AdminAddMemberArgs,
  AdminAddMemberOutcome,
  AdminOrganizationCounts,
  AdminOrganizationListQuery,
  AdminOrganizationRecord,
  AdminOrgListQuery,
  AdminOrgMemberRecord,
  AdminOrgVerificationRecord,
  AdminSetMemberRoleArgs,
  AdminSetMemberRoleOutcome,
  ApplyOrgVerificationArgs,
  CreateOrganizationArgs,
  CreateOrganizationInviteArgs,
  CreateOrganizationInviteOutcome,
  DecideOrgVerificationArgs,
  DecideOrgVerificationOutcome,
  OrganizationInviteRecord,
  OrganizationMemberRecord,
  OrganizationOwnerRecord,
  OrganizationRecord,
  OrganizationRepository,
  OrgMemberIdentifier,
  OrgVerificationRecord,
  RemoveOrganizationMemberOutcome,
  RevokeOrganizationInviteOutcome,
  SetOrganizationMemberRoleOutcome,
  SetOrganizationSuspendedArgs,
  SetOrganizationSuspendedOutcome,
  UpdateOrganizationAudit,
  UpdateOrganizationOutcome,
  UpdateOrganizationPatch,
} from "./organization-repository.types.js"

const PG_UNIQUE_VIOLATION = "23505"

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  )
}

/** The citext unique index on organizations.slug (0105). */
const ORG_SLUG_INDEX = "organizations_slug_uidx"

/**
 * A unique violation is only "slug taken" when it is THAT index. postgres.js surfaces the violated
 * index/constraint on `constraint_name`; any other unique violation inside the transaction (the owner
 * partial index, a media claim, ...) is a bug to surface, not a 409 to hand the caller.
 */
function isSlugTaken(err: unknown): boolean {
  if (!isUniqueViolation(err)) return false
  const e = err as { constraint_name?: unknown }
  return typeof e.constraint_name === "string" && e.constraint_name === ORG_SLUG_INDEX
}

interface OrganizationRowSelect {
  id: string
  slug: string
  name: string
  description: string | null
  website_url: string | null
  logo_media_id: string | null
  logo_key: string | null
  social_links: SocialLinks | null
  verified_status: OrgVerificationStatus
  verified_kind: OrgVerificationKind | null
  verified_at: Date | null
  created_by: string | null
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
  suspended_at: Date | null
  suspended_reason: string | null
  member_count: number
  event_count: number
  my_role: OrganizationMemberRole | null
}

interface AdminOrganizationRowSelect extends OrganizationRowSelect {
  owner_id: string | null
  owner_name: string | null
  owner_handle: string | null
  owner_joined: Date | null
  donations_enabled: boolean
  payments_state: OrgPaymentsState | null
}

function toOrganizationRecord(row: OrganizationRowSelect): OrganizationRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    websiteUrl: row.website_url,
    logoMediaId: row.logo_media_id,
    logoKey: row.logo_key,
    socialLinks: row.social_links,
    verifiedStatus: row.verified_status,
    verifiedKind: row.verified_kind,
    verifiedAt: row.verified_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    suspendedAt: row.suspended_at,
    suspendedReason: row.suspended_reason,
    memberCount: Number(row.member_count),
    eventCount: Number(row.event_count),
    myRole: row.my_role,
  }
}

function toAdminOrganizationRecord(row: AdminOrganizationRowSelect): AdminOrganizationRecord {
  return {
    ...toOrganizationRecord(row),
    owner:
      row.owner_id === null
        ? null
        : {
            id: row.owner_id,
            name: row.owner_name ?? "Unknown",
            handle: row.owner_handle ?? "",
            joined: row.owner_joined ?? new Date(0),
          },
    donationsEnabled: row.donations_enabled === true,
    paymentsState: row.payments_state,
  }
}

/** Owner + donation/payout state columns; assumes the admin joins (own/ou/ds/sa) below are in the FROM. */
function adminOrganizationColumns(sql: Queryable) {
  return sql`
    ${organizationColumns(sql, null)},
    ou.id AS owner_id,
    ou.display_name AS owner_name,
    ou.handle AS owner_handle,
    ou.created_at AS owner_joined,
    COALESCE(ds.enabled, false) AS donations_enabled,
    sa.onboarding_state AS payments_state
  `
}

function adminOrganizationJoins(sql: Queryable) {
  return sql`
    LEFT JOIN media_assets am ON am.id = o.logo_media_id
    LEFT JOIN organization_members own ON own.organization_id = o.id AND own.role = 'owner'
    LEFT JOIN users ou ON ou.id = own.user_id
    LEFT JOIN org_donation_settings ds ON ds.organization_id = o.id
    LEFT JOIN org_stripe_accounts sa ON sa.organization_id = o.id
  `
}

function organizationColumns(sql: Queryable, viewerId: string | null) {
  return sql`
    o.id,
    o.slug,
    o.name,
    o.description,
    o.website_url,
    o.logo_media_id,
    ${servedKeyExpr(sql, "am")} AS logo_key,
    o.social_links,
    o.verified_status,
    o.verified_kind,
    o.verified_at,
    o.created_by,
    o.created_at,
    o.updated_at,
    o.deleted_at,
    o.suspended_at,
    o.suspended_reason,
    (SELECT count(*)::int FROM organization_members om WHERE om.organization_id = o.id)
      AS member_count,
    (
      SELECT count(*)::int FROM cleanups c
      WHERE c.organization_id = o.id
        AND (
          (c.visibility = 'public' AND c.status <> 'cancelled')
          OR EXISTS (
            SELECT 1 FROM organization_members vm
            WHERE vm.organization_id = o.id AND vm.user_id = ${viewerId}::uuid
          )
        )
    ) AS event_count,
    (
      SELECT om.role FROM organization_members om
      WHERE om.organization_id = o.id AND om.user_id = ${viewerId}::uuid
      LIMIT 1
    ) AS my_role
  `
}

interface VerificationRowSelect {
  status: OrgVerificationStatus
  kind: OrgVerificationKind
  submitted_at: Date | null
  reviewed_at: Date | null
  rejection_reason: string | null
}

function toVerificationRecord(row: VerificationRowSelect): OrgVerificationRecord {
  return {
    status: row.status,
    kind: row.kind,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    rejectionReason: row.rejection_reason,
  }
}

async function claimOrgLogoInTx(
  tx: Queryable,
  organizationId: string,
  logoMediaId: string | null,
): Promise<void> {
  if (logoMediaId === null) return
  const claimed = await tx<{ id: string }[]>`
    UPDATE media_assets
    SET purpose = 'org_logo'
    WHERE id = ${logoMediaId}
      AND purpose <> 'verification'
      AND report_id IS NULL AND post_id IS NULL AND chat_message_id IS NULL
      AND (status = 'ready' OR (status = 'validating' AND finalized_at IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_media_id = media_assets.id)
      AND NOT EXISTS (SELECT 1 FROM chat_groups cg WHERE cg.avatar_media_id = media_assets.id)
      AND NOT EXISTS (
        SELECT 1 FROM organizations og
        WHERE og.id <> ${organizationId} AND og.logo_media_id = media_assets.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM cleanups oc
        WHERE oc.cover_media_id = media_assets.id
           OR oc.gallery_media_ids @> ARRAY[media_assets.id]
      )
      AND (
        EXISTS (
          SELECT 1 FROM organizations cur
          WHERE cur.id = ${organizationId} AND cur.logo_media_id = media_assets.id
        )
        OR media_assets.created_at > now() - make_interval(secs => ${MEDIA_CLAIM_WINDOW_SEC})
      )
    RETURNING id
  `
  if (claimed.length !== 1) {
    throw AppError.validation({ logoMediaId: "That image is unavailable." })
  }
}

export function documentMediaIdsOf(
  documents: { mediaId?: string }[] | null | undefined,
): string[] {
  const out: string[] = []
  for (const doc of documents ?? []) {
    if (typeof doc.mediaId === "string" && !out.includes(doc.mediaId)) out.push(doc.mediaId)
  }
  return out
}

async function claimVerificationDocumentsInTx(
  tx: Queryable,
  mediaIds: readonly string[],
): Promise<void> {
  if (mediaIds.length === 0) return
  const claimed = await tx<{ id: string }[]>`
    UPDATE media_assets
    SET purpose = 'verification'
    WHERE id = ANY(${[...mediaIds]}::uuid[])
      AND report_id IS NULL AND post_id IS NULL AND chat_message_id IS NULL
      AND (status = 'ready' OR (status = 'validating' AND finalized_at IS NOT NULL))
      AND created_at > now() - make_interval(secs => ${MEDIA_CLAIM_WINDOW_SEC})
      AND NOT (${mediaBoundElsewhere(tx, null)})
    RETURNING id
  `
  if (claimed.length !== new Set(mediaIds).size) {
    throw AppError.validation({ documents: "One or more documents are unavailable." })
  }
}

export function makeDrizzleOrganizationRepository(sql: Sql): OrganizationRepository {
  async function readById(
    tag: Queryable,
    id: string,
    viewerId: string | null,
  ): Promise<OrganizationRecord | null> {
    const rows = await tag<OrganizationRowSelect[]>`
      SELECT ${organizationColumns(tag, viewerId)}
      FROM organizations o
      LEFT JOIN media_assets am ON am.id = o.logo_media_id
      WHERE o.id = ${id} AND o.deleted_at IS NULL
      LIMIT 1
    `
    return rows[0] ? toOrganizationRecord(rows[0]) : null
  }

  async function adminRowFor(
    tag: Queryable,
    organizationId: string,
  ): Promise<AdminOrgVerificationRecord | null> {
    const rows = await tag<AdminVerificationRowSelect[]>`
      SELECT ${adminVerificationColumns(tag)}
      FROM org_verifications v
      JOIN organizations o ON o.id = v.organization_id
      LEFT JOIN users su ON su.id = v.submitted_by
      LEFT JOIN users ru ON ru.id = v.reviewed_by
      WHERE v.organization_id = ${organizationId}
      ORDER BY v.submitted_at DESC, v.id DESC
      LIMIT 1
    `
    return rows[0] ? toAdminVerificationRecord(rows[0]) : null
  }

  return {
    async createOrganizationTx(
      args: CreateOrganizationArgs,
    ): Promise<OrganizationRecord | "slug_taken"> {
      const ownerUserId = args.ownerUserId ?? args.createdBy
      const verifiedKind = args.verifiedKind ?? null
      try {
        return await sql.begin(async (tx) => {
          await tx`
            INSERT INTO organizations (
              id, slug, name, description, website_url, logo_media_id, social_links,
              verified_status, verified_kind, verified_at,
              created_by, created_at, updated_at
            ) VALUES (
              ${args.organizationId},
              ${args.slug},
              ${args.name},
              ${args.description},
              ${args.websiteUrl},
              ${args.logoMediaId},
              ${args.socialLinks === null ? null : tx.json(args.socialLinks)},
              ${verifiedKind === null ? "unverified" : "verified"},
              ${verifiedKind},
              ${verifiedKind === null ? null : args.now},
              ${args.createdBy},
              ${args.now},
              ${args.now}
            )
          `
          await tx`
            INSERT INTO organization_members (organization_id, user_id, role, joined_at)
            VALUES (${args.organizationId}, ${ownerUserId}, 'owner', ${args.now})
          `
          await claimOrgLogoInTx(tx, args.organizationId, args.logoMediaId)
          if (args.operatorReason !== undefined) {
            await writeHostAudit(tx, {
              actorId: args.createdBy,
              action: "org.created",
              target: `organization:${args.organizationId}`,
              meta: {
                reason: args.operatorReason,
                ownerUserId,
                slug: args.slug,
                verifiedKind,
              },
            })
          }
          if (verifiedKind !== null) {
            // An operator-created verified org gets the same decided verification row + audit entry a
            // self-submitted application would end with, so adminGetOrg.verification and the audit trail
            // read identically whichever path verified it (DECISIONS §32).
            await tx`
              INSERT INTO org_verifications (
                organization_id, status, kind, documents, note,
                submitted_by, submitted_at, reviewed_by, reviewed_at
              ) VALUES (
                ${args.organizationId}, 'verified', ${verifiedKind}, '[]'::jsonb,
                'Created verified by an operator.',
                ${args.createdBy}, ${args.now}, ${args.createdBy}, ${args.now}
              )
            `
            await writeHostAudit(tx, {
              actorId: args.createdBy,
              action: "org.verification_verified",
              target: `organization:${args.organizationId}`,
              meta: { kind: verifiedKind, reason: args.operatorReason ?? null, source: "operator_create" },
            })
          }
          const created = await readById(tx, args.organizationId, ownerUserId)
          if (created === null) throw AppError.internal()
          return created
        })
      } catch (err) {
        if (isUniqueViolation(err)) return "slug_taken"
        throw err
      }
    },

    findOrganizationById(id: string, viewerId: string | null): Promise<OrganizationRecord | null> {
      return readById(sql, id, viewerId)
    },

    async findOrganizationBySlug(
      slug: string,
      viewerId: string | null,
    ): Promise<OrganizationRecord | null> {
      const rows = await sql<OrganizationRowSelect[]>`
        SELECT ${organizationColumns(sql, viewerId)}
        FROM organizations o
        LEFT JOIN media_assets am ON am.id = o.logo_media_id
        WHERE o.slug = ${slug} AND o.deleted_at IS NULL
        LIMIT 1
      `
      return rows[0] ? toOrganizationRecord(rows[0]) : null
    },

    async listMyOrganizations(userId: string, limit: number): Promise<OrganizationRecord[]> {
      const rows = await sql<OrganizationRowSelect[]>`
        SELECT ${organizationColumns(sql, userId)}
        FROM organizations o
        JOIN organization_members m ON m.organization_id = o.id AND m.user_id = ${userId}
        LEFT JOIN media_assets am ON am.id = o.logo_media_id
        WHERE o.deleted_at IS NULL
        ORDER BY o.name ASC, o.id ASC
        LIMIT ${limit}
      `
      return rows.map(toOrganizationRecord)
    },

    async updateOrganizationTx(
      id: string,
      patch: UpdateOrganizationPatch,
      now: Date,
      audit?: UpdateOrganizationAudit,
    ): Promise<UpdateOrganizationOutcome> {
      const sets: postgres.Fragment[] = [sql`updated_at = ${now}`]
      if (patch.name !== undefined) sets.push(sql`name = ${patch.name}`)
      if (patch.slug !== undefined) sets.push(sql`slug = ${patch.slug}`)
      if (patch.description !== undefined) sets.push(sql`description = ${patch.description}`)
      if (patch.websiteUrl !== undefined) sets.push(sql`website_url = ${patch.websiteUrl}`)
      if (patch.logoMediaId !== undefined) sets.push(sql`logo_media_id = ${patch.logoMediaId}`)
      if (patch.socialLinks !== undefined) {
        sets.push(
          sql`social_links = ${patch.socialLinks === null ? null : sql.json(patch.socialLinks)}`,
        )
      }
      const setList = sets.reduce((acc, frag, i) => (i === 0 ? frag : sql`${acc}, ${frag}`))
      try {
        return await sql.begin(async (tx): Promise<UpdateOrganizationOutcome> => {
          const updated = await tx<{ id: string }[]>`
            UPDATE organizations SET ${setList}
            WHERE id = ${id} AND deleted_at IS NULL
            RETURNING id
          `
          if (updated.length === 0) return "not_found"
          await claimOrgLogoInTx(tx, id, patch.logoMediaId ?? null)
          if (audit !== undefined) {
            await writeHostAudit(tx, {
              actorId: audit.actorId,
              action: "org.updated",
              target: `organization:${id}`,
              meta: { reason: audit.reason, changed: audit.changed },
            })
          }
          return "updated"
        })
      } catch (err) {
        if (isSlugTaken(err)) return "slug_taken"
        throw err
      }
    },

    async roleOf(organizationId: string, userId: string): Promise<OrganizationMemberRole | null> {
      const rows = await sql<{ role: OrganizationMemberRole }[]>`
        SELECT om.role
        FROM organization_members om
        JOIN organizations o ON o.id = om.organization_id AND o.deleted_at IS NULL
        WHERE om.organization_id = ${organizationId} AND om.user_id = ${userId}
        LIMIT 1
      `
      return rows[0]?.role ?? null
    },

    async listMembers(args: {
      organizationId: string
      cursor: string | null
      limit: number
    }): Promise<{ items: OrganizationMemberRecord[]; nextCursor: string | null }> {
      const cursor = parseTimeCursor(args.cursor)
      const cursorFilter =
        cursor !== null
          ? sql`AND (m.joined_at, m.user_id) > (${cursor.at}, ${cursor.id}::uuid)`
          : sql``
      const rows = await sql<
        {
          user_id: string
          display_name: string
          handle: string | null
          bio: string | null
          role: OrganizationMemberRole
          joined_at: Date
        }[]
      >`
        SELECT m.user_id, u.display_name, u.handle, u.bio, m.role, m.joined_at
        FROM organization_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${args.organizationId}
          ${cursorFilter}
        ORDER BY m.joined_at ASC, m.user_id ASC
        LIMIT ${args.limit + 1}
      `
      return pageWith(
        rows.map((r) => ({
          person: {
            id: r.user_id,
            displayName: r.display_name,
            handle: r.handle,
            bio: r.bio,
          },
          role: r.role,
          joinedAt: r.joined_at,
        })),
        args.limit,
        (last) => encodeTimeCursor({ at: last.joinedAt, id: last.person.id }),
      )
    },

    async findMember(
      organizationId: string,
      userId: string,
    ): Promise<OrganizationMemberRecord | null> {
      const rows = await sql<
        {
          user_id: string
          display_name: string
          handle: string | null
          bio: string | null
          role: OrganizationMemberRole
          joined_at: Date
        }[]
      >`
        SELECT m.user_id, u.display_name, u.handle, u.bio, m.role, m.joined_at
        FROM organization_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${organizationId} AND m.user_id = ${userId}
        LIMIT 1
      `
      const r = rows[0]
      if (r === undefined) return null
      return {
        person: {
          id: r.user_id,
          displayName: r.display_name,
          handle: r.handle,
          bio: r.bio,
        },
        role: r.role,
        joinedAt: r.joined_at,
      }
    },

    async findOwner(organizationId: string): Promise<OrganizationOwnerRecord | null> {
      const rows = await sql<
        {
          user_id: string
          display_name: string
          handle: string
          email: string | null
          created_at: Date
        }[]
      >`
        SELECT m.user_id, u.display_name, u.handle, u.email, u.created_at
        FROM organization_members m
        JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
        WHERE m.organization_id = ${organizationId} AND m.role = 'owner'
        LIMIT 1
      `
      const r = rows[0]
      return r === undefined
        ? null
        : {
            userId: r.user_id,
            displayName: r.display_name,
            handle: r.handle,
            email: r.email,
            joined: r.created_at,
          }
    },

    async findUser(userId: string): Promise<AdminActorView | null> {
      const rows = await sql<
        { id: string; display_name: string; handle: string; created_at: Date }[]
      >`
        SELECT id, display_name, handle, created_at FROM users
        WHERE id = ${userId} AND deleted_at IS NULL
        LIMIT 1
      `
      const r = rows[0]
      return r === undefined
        ? null
        : { id: r.id, name: r.display_name, handle: r.handle, joined: r.created_at }
    },

    async resolveUserByIdentifier(identifier: OrgMemberIdentifier): Promise<string | null> {
      const rows =
        identifier.identifierKind === "handle"
          ? await sql<{ id: string }[]>`
              SELECT id FROM users
              WHERE handle = ${identifier.identifier} AND deleted_at IS NULL
              LIMIT 1
            `
          : await sql<{ id: string }[]>`
              SELECT id FROM users
              WHERE email = ${identifier.identifier}
                AND email_verified = true
                AND deleted_at IS NULL
              LIMIT 1
            `
      return rows[0]?.id ?? null
    },

    async addMemberTx(args: {
      organizationId: string
      userId: string
      role: "admin" | "member"
      actorId: string
      now: Date
    }): Promise<AddOrganizationMemberOutcome> {
      return sql.begin(async (tx) => {
        const inserted = await tx<{ user_id: string }[]>`
          INSERT INTO organization_members (organization_id, user_id, role, joined_at)
          VALUES (${args.organizationId}, ${args.userId}, ${args.role}, ${args.now})
          ON CONFLICT (organization_id, user_id) DO NOTHING
          RETURNING user_id
        `
        if (inserted.length === 0) return "already_member"
        await writeHostAudit(tx, {
          actorId: args.actorId,
          action: "org.member_role_changed",
          target: `organization:${args.organizationId}`,
          meta: { targetUserId: args.userId, from: null, to: args.role },
        })
        return "added"
      })
    },

    async setMemberRoleTx(args: {
      organizationId: string
      userId: string
      role: "admin" | "member"
      actorId: string
    }): Promise<SetOrganizationMemberRoleOutcome> {
      return sql.begin(async (tx) => {
        const current = await tx<{ role: OrganizationMemberRole }[]>`
          SELECT role FROM organization_members
          WHERE organization_id = ${args.organizationId} AND user_id = ${args.userId}
          LIMIT 1
          FOR UPDATE
        `
        const existing = current[0]
        if (existing === undefined) return "not_member"
        if (existing.role === "owner") return "owner"
        if (existing.role === args.role) return "updated"
        await tx`
          UPDATE organization_members SET role = ${args.role}
          WHERE organization_id = ${args.organizationId} AND user_id = ${args.userId}
        `
        await writeHostAudit(tx, {
          actorId: args.actorId,
          action: "org.member_role_changed",
          target: `organization:${args.organizationId}`,
          meta: { targetUserId: args.userId, from: existing.role, to: args.role },
        })
        return "updated"
      })
    },

    async removeMemberTx(args: {
      organizationId: string
      userId: string
      actorId: string
      reason?: string
    }): Promise<RemoveOrganizationMemberOutcome> {
      return sql.begin(async (tx) => {
        const removed = await tx<{ role: OrganizationMemberRole }[]>`
          DELETE FROM organization_members
          WHERE organization_id = ${args.organizationId}
            AND user_id = ${args.userId}
            AND role <> 'owner'
          RETURNING role
        `
        if (removed.length === 0) {
          const still = await tx<{ role: OrganizationMemberRole }[]>`
            SELECT role FROM organization_members
            WHERE organization_id = ${args.organizationId} AND user_id = ${args.userId}
            LIMIT 1
          `
          return still.length > 0 ? "owner" : "not_member"
        }
        await tx`
          UPDATE users SET primary_organization_id = NULL
          WHERE id = ${args.userId} AND primary_organization_id = ${args.organizationId}
        `
        await writeHostAudit(tx, {
          actorId: args.actorId,
          action: "org.member_removed",
          target: `organization:${args.organizationId}`,
          meta: {
            targetUserId: args.userId,
            role: removed[0]?.role ?? null,
            ...(args.reason !== undefined ? { reason: args.reason } : {}),
          },
        })
        return "removed"
      })
    },

    async applyVerificationTx(args: ApplyOrgVerificationArgs): Promise<OrgVerificationRecord> {
      return sql.begin(async (tx) => {
        await tx`
          SELECT id FROM organizations WHERE id = ${args.organizationId} LIMIT 1 FOR UPDATE
        `
        const open = await tx<{ id: string; documents: { mediaId?: string }[] | null }[]>`
          SELECT id, documents FROM org_verifications
          WHERE organization_id = ${args.organizationId} AND status = 'pending'
          ORDER BY submitted_at DESC, id DESC
          LIMIT 1
          FOR UPDATE
        `
        const openRow = open[0]
        const carried = documentMediaIdsOf(openRow?.documents)
        const submitted = documentMediaIdsOf(args.documentMediaIds.map((mediaId) => ({ mediaId })))
        const effective = submitted.length === 0 ? carried : submitted
        const fresh = effective.filter((mediaId) => !carried.includes(mediaId))
        const documents = tx.json(effective.map((mediaId) => ({ mediaId })))
        const updated =
          openRow === undefined
            ? []
            : await tx<VerificationRowSelect[]>`
                UPDATE org_verifications
                SET kind = ${args.kind},
                    ein_number = ${args.einNumber},
                    ein_scrubbed_at = NULL,
                    documents = ${documents},
                    note = ${args.note},
                    submitted_by = ${args.submittedBy},
                    submitted_at = ${args.now}
                WHERE id = ${openRow.id}
                RETURNING status, kind, submitted_at, reviewed_at, rejection_reason
              `
        const rows =
          updated.length > 0
            ? updated
            : await tx<VerificationRowSelect[]>`
                INSERT INTO org_verifications (
                  id, organization_id, status, kind, ein_number, documents, note,
                  submitted_by, submitted_at
                ) VALUES (
                  ${args.verificationId},
                  ${args.organizationId},
                  'pending',
                  ${args.kind},
                  ${args.einNumber},
                  ${documents},
                  ${args.note},
                  ${args.submittedBy},
                  ${args.now}
                )
                RETURNING status, kind, submitted_at, reviewed_at, rejection_reason
              `
        await claimVerificationDocumentsInTx(tx, fresh)
        const dropped = carried.filter((mediaId) => !effective.includes(mediaId))
        if (dropped.length > 0) {
          await tx`
            UPDATE media_assets SET purpose = 'report'
             WHERE id = ANY(${dropped}::uuid[]) AND purpose = 'verification'
          `
        }
        await tx`
          UPDATE organizations
          SET verified_status = 'pending', updated_at = ${args.now}
          WHERE id = ${args.organizationId} AND verified_status <> 'verified'
        `
        await writeHostAudit(tx, {
          actorId: args.submittedBy,
          action: "org.verification_submitted",
          target: `organization:${args.organizationId}`,
          meta: { kind: args.kind, documentCount: effective.length },
        })
        const row = rows[0]
        if (row === undefined) throw AppError.internal()
        return toVerificationRecord(row)
      })
    },

    async getVerification(organizationId: string): Promise<OrgVerificationRecord | null> {
      const rows = await sql<VerificationRowSelect[]>`
        SELECT status, kind, submitted_at, reviewed_at, rejection_reason
        FROM org_verifications
        WHERE organization_id = ${organizationId}
        ORDER BY submitted_at DESC, id DESC
        LIMIT 1
      `
      return rows[0] ? toVerificationRecord(rows[0]) : null
    },

    async adminListVerifications(query: AdminOrgListQuery): Promise<{
      items: AdminOrgVerificationRecord[]
      nextCursor: string | null
      pendingCount: number
    }> {
      const cursor = parseTimeCursor(query.cursor)
      const cursorFilter =
        cursor !== null
          ? sql`AND (v.submitted_at, v.id) < (${cursor.at}, ${cursor.id}::uuid)`
          : sql``
      const statusFilter =
        query.status !== undefined ? sql`AND v.status = ${query.status}` : sql``
      const kindFilter = query.kind !== undefined ? sql`AND v.kind = ${query.kind}` : sql``
      const qFilter =
        query.q !== undefined && query.q.length > 0
          ? sql`AND (o.name ILIKE ${likeContains(query.q)} ESCAPE '\\'
                     OR o.slug ILIKE ${likeContains(query.q)} ESCAPE '\\')`
          : sql``
      const rows = await sql<AdminVerificationRowSelect[]>`
        SELECT ${adminVerificationColumns(sql)}
        FROM org_verifications v
        JOIN organizations o ON o.id = v.organization_id
        LEFT JOIN users su ON su.id = v.submitted_by
        LEFT JOIN users ru ON ru.id = v.reviewed_by
        WHERE TRUE
          ${statusFilter}
          ${kindFilter}
          ${qFilter}
          ${cursorFilter}
        ORDER BY v.submitted_at DESC, v.id DESC
        LIMIT ${query.limit + 1}
      `
      const pending = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM org_verifications WHERE status = 'pending'
      `
      const page = pageWith(rows.map(toAdminVerificationRecord), query.limit, (last) =>
        last.submittedAt === null ? null : encodeTimeCursor({ at: last.submittedAt, id: last.id }),
      )
      return { ...page, pendingCount: pending[0]?.count ?? 0 }
    },

    adminGetVerification(organizationId: string): Promise<AdminOrgVerificationRecord | null> {
      return adminRowFor(sql, organizationId)
    },

    async adminGetVerifications(
      organizationIds: string[],
    ): Promise<Map<string, AdminOrgVerificationRecord>> {
      const out = new Map<string, AdminOrgVerificationRecord>()
      if (organizationIds.length === 0) return out
      const rows = await sql<AdminVerificationRowSelect[]>`
        SELECT DISTINCT ON (v.organization_id) ${adminVerificationColumns(sql)}
        FROM org_verifications v
        JOIN organizations o ON o.id = v.organization_id
        LEFT JOIN users su ON su.id = v.submitted_by
        LEFT JOIN users ru ON ru.id = v.reviewed_by
        WHERE v.organization_id = ANY(${[...organizationIds]}::uuid[])
        ORDER BY v.organization_id, v.submitted_at DESC, v.id DESC
      `
      for (const row of rows) out.set(row.organization_id, toAdminVerificationRecord(row))
      return out
    },

    async adminFindOrganization(id: string): Promise<AdminOrganizationRecord | null> {
      const rows = await sql<AdminOrganizationRowSelect[]>`
        SELECT ${adminOrganizationColumns(sql)}
        FROM organizations o
        ${adminOrganizationJoins(sql)}
        WHERE o.id = ${id} AND o.deleted_at IS NULL
        LIMIT 1
      `
      return rows[0] ? toAdminOrganizationRecord(rows[0]) : null
    },

    async adminListOrganizations(query: AdminOrganizationListQuery): Promise<{
      items: AdminOrganizationRecord[]
      nextCursor: string | null
      counts: AdminOrganizationCounts | null
    }> {
      const cursor = parseTimeCursor(query.cursor)
      const q = query.q?.trim() ?? ""
      const qFilter =
        q.length > 0
          ? sql`AND (o.name ILIKE ${likeContains(q)} ESCAPE '\\'
                     OR o.slug ILIKE ${likeContains(q)} ESCAPE '\\'
                     ${isUuid(q) ? sql`OR o.id = ${q}::uuid` : sql``})`
          : sql``
      const verifiedFilter =
        query.verified !== undefined ? sql`AND o.verified_status = ${query.verified}` : sql``
      const kindFilter = query.kind !== undefined ? sql`AND o.verified_kind = ${query.kind}` : sql``
      const suspendedFilter =
        query.suspended === undefined
          ? sql``
          : query.suspended
            ? sql`AND o.suspended_at IS NOT NULL`
            : sql`AND o.suspended_at IS NULL`
      const donationsFilter =
        query.donationsEnabled === undefined
          ? sql``
          : sql`AND COALESCE(ds.enabled, false) = ${query.donationsEnabled}`
      const cursorFilter =
        cursor !== null
          ? sql`AND (o.created_at, o.id) < (${cursor.at}, ${cursor.id}::uuid)`
          : sql``
      const rows = await sql<AdminOrganizationRowSelect[]>`
        SELECT ${adminOrganizationColumns(sql)}
        FROM organizations o
        ${adminOrganizationJoins(sql)}
        WHERE o.deleted_at IS NULL
          ${qFilter}
          ${verifiedFilter}
          ${kindFilter}
          ${suspendedFilter}
          ${donationsFilter}
          ${cursorFilter}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT ${query.limit + 1}
      `
      const page = pageWith(rows.map(toAdminOrganizationRecord), query.limit, (last) =>
        encodeTimeCursor({ at: last.createdAt, id: last.id }),
      )
      // Facet counts span the SEARCHED set but ignore the facets, and only on page one (the shared
      // admin-list policy: the console reads the chip numbers off the first page).
      let counts: AdminOrganizationCounts | null = null
      if (cursor === null) {
        const totals = await sql<
          { all: number; verified: number; pending: number; suspended: number }[]
        >`
          SELECT
            count(*)::int AS all,
            count(*) FILTER (WHERE o.verified_status = 'verified')::int AS verified,
            count(*) FILTER (WHERE o.verified_status = 'pending')::int AS pending,
            count(*) FILTER (WHERE o.suspended_at IS NOT NULL)::int AS suspended
          FROM organizations o
          WHERE o.deleted_at IS NULL
            ${qFilter}
        `
        const t = totals[0]
        counts = {
          all: Number(t?.all ?? 0),
          verified: Number(t?.verified ?? 0),
          pending: Number(t?.pending ?? 0),
          suspended: Number(t?.suspended ?? 0),
        }
      }
      return { ...page, counts }
    },

    async setSuspendedTx(
      args: SetOrganizationSuspendedArgs,
    ): Promise<SetOrganizationSuspendedOutcome> {
      return sql.begin(async (tx) => {
        const updated = await tx<{ id: string }[]>`
          UPDATE organizations
          SET suspended_at = ${args.suspended ? args.now : null},
              suspended_reason = ${args.suspended ? args.reason : null},
              suspended_by = ${args.suspended ? args.actorId : null},
              updated_at = ${args.now}
          WHERE id = ${args.organizationId} AND deleted_at IS NULL
          RETURNING id
        `
        if (updated.length === 0) return "not_found"
        await writeHostAudit(tx, {
          actorId: args.actorId,
          action: args.suspended ? "org.suspended" : "org.unsuspended",
          target: `organization:${args.organizationId}`,
          meta: { reason: args.reason },
        })
        return "updated"
      })
    },

    async adminListMembers(args: {
      organizationId: string
      cursor: string | null
      limit: number
    }): Promise<{ items: AdminOrgMemberRecord[]; nextCursor: string | null }> {
      const cursor = parseTimeCursor(args.cursor)
      const cursorFilter =
        cursor !== null
          ? sql`AND (m.joined_at, m.user_id) > (${cursor.at}, ${cursor.id}::uuid)`
          : sql``
      const rows = await sql<
        {
          user_id: string
          display_name: string
          handle: string
          created_at: Date
          role: OrganizationMemberRole
          joined_at: Date
        }[]
      >`
        SELECT m.user_id, u.display_name, u.handle, u.created_at, m.role, m.joined_at
        FROM organization_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${args.organizationId}
          ${cursorFilter}
        ORDER BY m.joined_at ASC, m.user_id ASC
        LIMIT ${args.limit + 1}
      `
      return pageWith(
        rows.map((r) => ({
          user: { id: r.user_id, name: r.display_name, handle: r.handle, joined: r.created_at },
          role: r.role,
          joinedAt: r.joined_at,
        })),
        args.limit,
        (last) => encodeTimeCursor({ at: last.joinedAt, id: last.user.id }),
      )
    },

    async adminAddMemberTx(args: AdminAddMemberArgs): Promise<AdminAddMemberOutcome> {
      return sql.begin(async (tx): Promise<AdminAddMemberOutcome> => {
        const org = await tx<{ id: string }[]>`
          SELECT id FROM organizations
          WHERE id = ${args.organizationId} AND deleted_at IS NULL
          LIMIT 1 FOR UPDATE
        `
        if (org.length === 0) return "not_found"
        const user = await tx<{ id: string }[]>`
          SELECT id FROM users WHERE id = ${args.userId} AND deleted_at IS NULL LIMIT 1
        `
        if (user.length === 0) return "user_not_found"
        const existing = await tx<{ role: OrganizationMemberRole }[]>`
          SELECT role FROM organization_members
          WHERE organization_id = ${args.organizationId} AND user_id = ${args.userId}
          LIMIT 1
        `
        if (existing.length > 0) return "already_member"
        let previousOwner: string | null = null
        if (args.role === "owner") {
          // Ownership transfer: exactly one owner per org (partial unique index), so the current owner
          // steps down to admin in the same transaction before the new owner is seated.
          const demoted = await tx<{ user_id: string }[]>`
            UPDATE organization_members SET role = 'admin'
            WHERE organization_id = ${args.organizationId} AND role = 'owner'
            RETURNING user_id
          `
          previousOwner = demoted[0]?.user_id ?? null
        }
        await tx`
          INSERT INTO organization_members (organization_id, user_id, role, joined_at)
          VALUES (${args.organizationId}, ${args.userId}, ${args.role}, ${args.now})
        `
        await writeHostAudit(tx, {
          actorId: args.actorId,
          action: "org.member_added",
          target: `organization:${args.organizationId}`,
          meta: { targetUserId: args.userId, role: args.role, reason: args.reason },
        })
        if (args.role === "owner") {
          await writeHostAudit(tx, {
            actorId: args.actorId,
            action: "org.ownership_transferred",
            target: `organization:${args.organizationId}`,
            meta: { from: previousOwner, to: args.userId, reason: args.reason },
          })
        }
        return "added"
      })
    },

    async adminSetMemberRoleTx(args: AdminSetMemberRoleArgs): Promise<AdminSetMemberRoleOutcome> {
      return sql.begin(async (tx): Promise<AdminSetMemberRoleOutcome> => {
        await tx`
          SELECT id FROM organizations WHERE id = ${args.organizationId} LIMIT 1 FOR UPDATE
        `
        const current = await tx<{ role: OrganizationMemberRole }[]>`
          SELECT role FROM organization_members
          WHERE organization_id = ${args.organizationId} AND user_id = ${args.userId}
          LIMIT 1
          FOR UPDATE
        `
        const existing = current[0]
        if (existing === undefined) return "not_member"
        if (existing.role === args.role) return "updated"
        if (existing.role === "owner") return "sole_owner"
        let previousOwner: string | null = null
        if (args.role === "owner") {
          const demoted = await tx<{ user_id: string }[]>`
            UPDATE organization_members SET role = 'admin'
            WHERE organization_id = ${args.organizationId} AND role = 'owner'
            RETURNING user_id
          `
          previousOwner = demoted[0]?.user_id ?? null
        }
        await tx`
          UPDATE organization_members SET role = ${args.role}
          WHERE organization_id = ${args.organizationId} AND user_id = ${args.userId}
        `
        await writeHostAudit(tx, {
          actorId: args.actorId,
          action: "org.member_role_changed",
          target: `organization:${args.organizationId}`,
          meta: {
            targetUserId: args.userId,
            from: existing.role,
            to: args.role,
            reason: args.reason,
          },
        })
        if (args.role === "owner") {
          await writeHostAudit(tx, {
            actorId: args.actorId,
            action: "org.ownership_transferred",
            target: `organization:${args.organizationId}`,
            meta: { from: previousOwner, to: args.userId, reason: args.reason },
          })
        }
        return "updated"
      })
    },

    async countPendingInvites(organizationId: string, now: Date): Promise<number> {
      const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM organization_invites
        WHERE organization_id = ${organizationId} AND status = 'pending' AND expires_at > ${now}
      `
      return Number(rows[0]?.count ?? 0)
    },

    async createInviteTx(
      args: CreateOrganizationInviteArgs,
    ): Promise<CreateOrganizationInviteOutcome> {
      return sql.begin(async (tx): Promise<CreateOrganizationInviteOutcome> => {
        await expireInvitesInTx(tx, args.organizationId, args.now)
        const inserted = await tx<{ id: string }[]>`
          INSERT INTO organization_invites (
            id, organization_id, email, user_id, role, token_hash, status, invited_by, created_at,
            expires_at
          ) VALUES (
            ${args.inviteId}, ${args.organizationId}, ${args.email}, ${args.userId}, ${args.role},
            ${args.tokenHash}, 'pending', ${args.invitedBy}, ${args.now}, ${args.expiresAt}
          )
          ON CONFLICT (organization_id, email) WHERE status = 'pending' AND email IS NOT NULL
          DO NOTHING
          RETURNING id
        `
        if (inserted.length === 0) {
          // A re-invite of an address with an open invite answers with THAT invite (idempotent), so the
          // inviter cannot tell an address apart by whether a second call 409s.
          const open = await tx<{ id: string }[]>`
            SELECT id FROM organization_invites
            WHERE organization_id = ${args.organizationId}
              AND email = ${args.email}
              AND status = 'pending'
            LIMIT 1
          `
          const openId = open[0]?.id
          if (openId === undefined) throw AppError.internal()
          const invite = await readInvite(tx, openId)
          if (invite === null) throw AppError.internal()
          return { kind: "already_invited", invite }
        }
        await writeHostAudit(tx, {
          actorId: args.invitedBy,
          action: "org.invite_created",
          target: `organization:${args.organizationId}`,
          meta: { inviteId: args.inviteId, role: args.role },
        })
        const invite = await readInvite(tx, args.inviteId)
        if (invite === null) throw AppError.internal()
        return { kind: "created", invite }
      })
    },

    async listInvites(
      organizationId: string,
      now: Date,
      limit: number,
    ): Promise<OrganizationInviteRecord[]> {
      await expireInvitesInTx(sql, organizationId, now)
      const rows = await sql<InviteRowSelect[]>`
        SELECT ${inviteColumns(sql)}
        FROM organization_invites i
        LEFT JOIN users iu ON iu.id = i.invited_by
        LEFT JOIN users au ON au.id = i.user_id
        WHERE i.organization_id = ${organizationId}
        ORDER BY (i.status = 'pending') DESC, i.created_at DESC, i.id DESC
        LIMIT ${limit}
      `
      return rows.map(toInviteRecord)
    },

    async revokeInviteTx(args: {
      organizationId: string
      inviteId: string
      actorId: string
      now: Date
    }): Promise<RevokeOrganizationInviteOutcome> {
      return sql.begin(async (tx): Promise<RevokeOrganizationInviteOutcome> => {
        const revoked = await tx<{ id: string }[]>`
          UPDATE organization_invites
          SET status = 'revoked', revoked_at = ${args.now}
          WHERE id = ${args.inviteId}
            AND organization_id = ${args.organizationId}
            AND status = 'pending'
          RETURNING id
        `
        if (revoked.length === 0) return "not_found"
        await writeHostAudit(tx, {
          actorId: args.actorId,
          action: "org.invite_revoked",
          target: `organization:${args.organizationId}`,
          meta: { inviteId: args.inviteId },
        })
        return "revoked"
      })
    },

    async listPendingInvitesForUser(args: {
      userId: string
      now: Date
      limit: number
    }): Promise<PendingOrganizationInviteRecord[]> {
      const rows = await sql<
        {
          id: string
          role: OrganizationInviteRole
          created_at: Date
          expires_at: Date
          invited_by_id: string | null
          invited_by_name: string | null
          invited_by_handle: string | null
          invited_by_bio: string | null
          organization_id: string
          organization_slug: string
          organization_name: string
          organization_logo_key: string | null
          organization_verified_status: OrgVerificationStatus
          organization_verified_kind: OrgVerificationKind | null
        }[]
      >`
        SELECT
          i.id,
          i.role,
          i.created_at,
          i.expires_at,
          iu.id AS invited_by_id,
          iu.display_name AS invited_by_name,
          iu.handle AS invited_by_handle,
          iu.bio AS invited_by_bio,
          o.id AS organization_id,
          o.slug AS organization_slug,
          o.name AS organization_name,
          ${servedKeyExpr(sql, "am")} AS organization_logo_key,
          o.verified_status AS organization_verified_status,
          o.verified_kind AS organization_verified_kind
        FROM organization_invites i
        JOIN organizations o ON o.id = i.organization_id
        LEFT JOIN users iu ON iu.id = i.invited_by
        LEFT JOIN media_assets am ON am.id = o.logo_media_id
        WHERE i.status = 'pending'
          AND i.expires_at > ${args.now}
          AND o.deleted_at IS NULL
          AND o.suspended_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM organization_members m
            WHERE m.organization_id = i.organization_id AND m.user_id = ${args.userId}
          )
          AND (
            i.user_id = ${args.userId}
            OR (
              i.email IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM users u
                WHERE u.id = ${args.userId}
                  AND u.email = i.email
                  AND u.email_verified = true
                  AND u.deleted_at IS NULL
              )
            )
          )
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT ${args.limit}
      `
      return rows.map((r) => ({
        id: r.id,
        role: r.role,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        invitedBy:
          r.invited_by_id === null
            ? null
            : {
                id: r.invited_by_id,
                displayName: r.invited_by_name ?? "",
                handle: r.invited_by_handle,
                bio: r.invited_by_bio,
              },
        organization: {
          id: r.organization_id,
          slug: r.organization_slug,
          name: r.organization_name,
          logoKey: r.organization_logo_key,
          verifiedStatus: r.organization_verified_status,
          verifiedKind: r.organization_verified_kind,
          suspended: false,
        },
      }))
    },

    async declineInviteTx(args: {
      inviteId: string
      userId: string
      now: Date
    }): Promise<DeclineOrganizationInviteOutcome> {
      return sql.begin(async (tx): Promise<DeclineOrganizationInviteOutcome> => {
        const rows = await tx<
          {
            id: string
            organization_id: string
            email: string | null
            user_id: string | null
            status: OrganizationInviteStatus
            expires_at: Date
          }[]
        >`
          SELECT id, organization_id, email, user_id, status, expires_at
          FROM organization_invites
          WHERE id = ${args.inviteId}
          LIMIT 1 FOR UPDATE
        `
        const invite = rows[0]
        if (invite === undefined || invite.status !== "pending") return "invalid"
        const addressed =
          invite.user_id !== null && invite.user_id === args.userId
            ? true
            : invite.email === null
              ? false
              : (
                  await tx<{ one: number }[]>`
                    SELECT 1 AS one FROM users
                    WHERE id = ${args.userId}
                      AND email = ${invite.email}
                      AND email_verified = true
                      AND deleted_at IS NULL
                    LIMIT 1
                  `
                ).length > 0
        if (!addressed) return "invalid"
        if (invite.expires_at.getTime() <= args.now.getTime()) {
          await tx`UPDATE organization_invites SET status = 'expired' WHERE id = ${invite.id}`
          return "expired"
        }
        await tx`
          UPDATE organization_invites
          SET status = 'declined', user_id = ${args.userId}
          WHERE id = ${invite.id}
        `
        await writeHostAudit(tx, {
          actorId: args.userId,
          action: "org.invite_declined",
          target: `organization:${invite.organization_id}`,
          meta: { inviteId: invite.id },
        })
        return "declined"
      })
    },

    async acceptInviteTx(args: {
      by: { tokenHash: string } | { inviteId: string }
      userId: string
      now: Date
    }): Promise<AcceptOrganizationInviteOutcome> {
      const byToken = "tokenHash" in args.by
      return sql.begin(async (tx): Promise<AcceptOrganizationInviteOutcome> => {
        const found = byToken
          ? await tx<{ id: string; organization_id: string }[]>`
              SELECT id, organization_id FROM organization_invites
              WHERE token_hash = ${(args.by as { tokenHash: string }).tokenHash}
              LIMIT 1
            `
          : await tx<{ id: string; organization_id: string }[]>`
              SELECT id, organization_id FROM organization_invites
              WHERE id = ${(args.by as { inviteId: string }).inviteId}
              LIMIT 1
            `
        const hit = found[0]
        if (hit === undefined) return { kind: "invalid" }
        // Lock order: organizations -> organization_members -> organization_invites.
        const org = await tx<{ id: string; suspended: boolean }[]>`
          SELECT id, (suspended_at IS NOT NULL) AS suspended FROM organizations
          WHERE id = ${hit.organization_id} AND deleted_at IS NULL
          LIMIT 1 FOR UPDATE
        `
        const orgRow = org[0]
        if (orgRow === undefined) return { kind: "invalid" }
        const invites = await tx<
          {
            id: string
            email: string | null
            user_id: string | null
            role: OrganizationInviteRole
            status: OrganizationInviteStatus
            expires_at: Date
          }[]
        >`
          SELECT id, email, user_id, role, status, expires_at FROM organization_invites
          WHERE id = ${hit.id}
          LIMIT 1 FOR UPDATE
        `
        const invite = invites[0]
        if (invite === undefined || invite.status !== "pending") return { kind: "invalid" }
        if (invite.expires_at.getTime() <= args.now.getTime()) {
          await tx`UPDATE organization_invites SET status = 'expired' WHERE id = ${invite.id}`
          return { kind: "expired" }
        }
        // The invite is a claim on the account that signs in with the invited address (verified), the
        // same rule cleanup_team_invites applies - never on whoever holds the link. The id-addressed
        // path has no token to prove anything, so the seat itself is the claim: the row must name this
        // account, or carry an address this account has verified.
        const addressed =
          invite.user_id !== null && invite.user_id === args.userId
            ? true
            : invite.email === null
              ? false
              : (
                  await tx<{ one: number }[]>`
                    SELECT 1 AS one FROM users
                    WHERE id = ${args.userId}
                      AND email = ${invite.email}
                      AND email_verified = true
                      AND deleted_at IS NULL
                    LIMIT 1
                  `
                ).length > 0
        if (byToken ? invite.email !== null && !addressed : !addressed) {
          return { kind: "wrong_recipient" }
        }
        if (orgRow.suspended) return { kind: "suspended" }
        const inserted = await tx<{ user_id: string }[]>`
          INSERT INTO organization_members (organization_id, user_id, role, joined_at)
          VALUES (${orgRow.id}, ${args.userId}, ${invite.role}, ${args.now})
          ON CONFLICT (organization_id, user_id) DO NOTHING
          RETURNING user_id
        `
        const alreadyMember = inserted.length === 0
        // An existing member keeps the role they already hold: accepting an invite never upgrades
        // (or downgrades) a seat, it only closes the invite.
        let role: OrganizationMemberRole = invite.role
        if (alreadyMember) {
          const seated = await tx<{ role: OrganizationMemberRole }[]>`
            SELECT role FROM organization_members
            WHERE organization_id = ${orgRow.id} AND user_id = ${args.userId}
            LIMIT 1
          `
          role = seated[0]?.role ?? invite.role
        }
        await tx`
          UPDATE organization_invites
          SET status = 'accepted', accepted_at = ${args.now}, user_id = ${args.userId}
          WHERE id = ${invite.id}
        `
        await writeHostAudit(tx, {
          actorId: args.userId,
          action: "org.invite_accepted",
          target: `organization:${orgRow.id}`,
          meta: { inviteId: invite.id, role, alreadyMember },
        })
        return {
          kind: "accepted",
          organizationId: orgRow.id,
          role,
          alreadyMember,
        }
      })
    },

    async decideVerificationTx(
      args: DecideOrgVerificationArgs,
    ): Promise<DecideOrgVerificationOutcome> {
      return sql.begin(async (tx) => {
        const org = await tx<{ id: string }[]>`
          SELECT id FROM organizations WHERE id = ${args.organizationId} LIMIT 1 FOR UPDATE
        `
        if (org.length === 0) return "not_found"
        const application = await tx<
          { id: string; kind: OrgVerificationKind; ein_number: string | null }[]
        >`
          SELECT id, kind, ein_number FROM org_verifications
          WHERE organization_id = ${args.organizationId} AND status = 'pending'
          ORDER BY submitted_at DESC, id DESC
          LIMIT 1
          FOR UPDATE
        `
        const open = application[0]
        if (open === undefined) return "no_application"
        const grantedKind = args.decision === "verified" ? (args.kind ?? open.kind) : open.kind
        await tx`
          UPDATE org_verifications
          SET status = ${args.decision},
              kind = ${grantedKind},
              rejection_reason = ${args.decision === "rejected" ? args.reason : null},
              reviewed_by = ${args.reviewedBy},
              reviewed_at = ${args.now}
          WHERE id = ${open.id}
        `
        await tx`
          UPDATE organizations
          SET verified_status = ${args.decision},
              verified_kind = ${args.decision === "verified" ? grantedKind : null},
              verified_at = ${args.decision === "verified" ? args.now : null},
              updated_at = ${args.now}
          WHERE id = ${args.organizationId}
        `
        const verifiedEin =
          args.decision === "verified" && grantedKind === "nonprofit" && open.ein_number !== null
            ? normalizeEin(open.ein_number)
            : null
        if (verifiedEin !== null) {
          await upsertOrgEligibilityEin(tx, {
            organizationId: args.organizationId,
            ein: verifiedEin,
            source: "org_verification",
            actorUserId: args.reviewedBy,
            now: args.now,
          })
        }
        if (args.decision !== "verified") {
          await tx`
            UPDATE cleanups SET donation_url = NULL
            WHERE organization_id = ${args.organizationId} AND donation_url IS NOT NULL
          `
        }
        await writeHostAudit(tx, {
          actorId: args.reviewedBy,
          action:
            args.decision === "verified" ? "org.verification_verified" : "org.verification_rejected",
          target: `organization:${args.organizationId}`,
          meta: { kind: grantedKind, reason: args.reason },
        })
        return "decided"
      })
    },

    async verifiedEinOf(organizationId: string): Promise<string | null> {
      const rows = await sql<{ ein_number: string | null }[]>`
        SELECT ein_number FROM org_verifications
        WHERE organization_id = ${organizationId} AND status = 'verified'
        ORDER BY reviewed_at DESC NULLS LAST, id DESC
        LIMIT 1
      `
      return rows[0]?.ein_number ?? null
    },

    async scrubDecidedEins(before: Date, limit: number): Promise<number> {
      const rows = await sql<{ id: string }[]>`
        UPDATE org_verifications SET ein_number = NULL, ein_scrubbed_at = now()
        WHERE id IN (
          SELECT id FROM org_verifications
          WHERE ein_number IS NOT NULL
            AND ein_scrubbed_at IS NULL
            AND reviewed_at IS NOT NULL
            AND reviewed_at < ${before}
          ORDER BY reviewed_at ASC
          LIMIT ${limit}
        )
        RETURNING id
      `
      return rows.length
    },
  }
}

interface AdminVerificationRowSelect {
  id: string
  organization_id: string
  slug: string
  name: string
  status: OrgVerificationStatus
  kind: OrgVerificationKind
  ein_last4: string | null
  documents: { mediaId?: string }[] | null
  note: string | null
  submitted_at: Date | null
  reviewed_at: Date | null
  rejection_reason: string | null
  submitted_by_id: string | null
  submitted_by_name: string | null
  submitted_by_handle: string | null
  submitted_by_joined: Date | null
  reviewed_by_id: string | null
  reviewed_by_name: string | null
  reviewed_by_handle: string | null
  reviewed_by_joined: Date | null
}

function adminVerificationColumns(sql: Queryable) {
  return sql`
    v.id,
    v.organization_id,
    o.slug,
    o.name,
    v.status,
    v.kind,
    right(v.ein_number, 4) AS ein_last4,
    v.documents,
    v.note,
    v.submitted_at,
    v.reviewed_at,
    v.rejection_reason,
    su.id AS submitted_by_id,
    su.display_name AS submitted_by_name,
    su.handle AS submitted_by_handle,
    su.created_at AS submitted_by_joined,
    ru.id AS reviewed_by_id,
    ru.display_name AS reviewed_by_name,
    ru.handle AS reviewed_by_handle,
    ru.created_at AS reviewed_by_joined
  `
}

function toAdminVerificationRecord(row: AdminVerificationRowSelect): AdminOrgVerificationRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    kind: row.kind,
    einLast4: row.ein_last4,
    documentMediaIds: documentMediaIdsOf(row.documents),
    note: row.note,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    rejectionReason: row.rejection_reason,
    submittedBy:
      row.submitted_by_id === null
        ? null
        : {
            id: row.submitted_by_id,
            name: row.submitted_by_name ?? "Unknown",
            handle: row.submitted_by_handle ?? "",
            joined: row.submitted_by_joined ?? new Date(0),
          },
    reviewedBy:
      row.reviewed_by_id === null
        ? null
        : {
            id: row.reviewed_by_id,
            name: row.reviewed_by_name ?? "Unknown",
            handle: row.reviewed_by_handle ?? "",
            joined: row.reviewed_by_joined ?? new Date(0),
          },
  }
}

async function expireInvitesInTx(tag: Queryable, organizationId: string, now: Date): Promise<void> {
  await tag`
    UPDATE organization_invites SET status = 'expired'
    WHERE organization_id = ${organizationId} AND status = 'pending' AND expires_at <= ${now}
  `
}

interface InviteRowSelect {
  id: string
  organization_id: string
  email: string | null
  role: OrganizationInviteRole
  status: OrganizationInviteStatus
  created_at: Date
  expires_at: Date
  user_id: string | null
  user_name: string | null
  user_handle: string | null
  user_bio: string | null
  invited_by_id: string | null
  invited_by_name: string | null
  invited_by_handle: string | null
  invited_by_bio: string | null
}

function inviteColumns(sql: Queryable) {
  return sql`
    i.id,
    i.organization_id,
    i.email,
    i.role,
    i.status,
    i.created_at,
    i.expires_at,
    au.id AS user_id,
    au.display_name AS user_name,
    au.handle AS user_handle,
    au.bio AS user_bio,
    iu.id AS invited_by_id,
    iu.display_name AS invited_by_name,
    iu.handle AS invited_by_handle,
    iu.bio AS invited_by_bio
  `
}

function toInviteRecord(row: InviteRowSelect): OrganizationInviteRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    user:
      row.user_id === null
        ? null
        : {
            id: row.user_id,
            displayName: row.user_name ?? "Unknown",
            handle: row.user_handle,
            bio: row.user_bio,
          },
    role: row.role,
    status: row.status,
    invitedBy:
      row.invited_by_id === null
        ? null
        : {
            id: row.invited_by_id,
            displayName: row.invited_by_name ?? "Unknown",
            handle: row.invited_by_handle,
            bio: row.invited_by_bio,
          },
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

async function readInvite(tag: Queryable, inviteId: string): Promise<OrganizationInviteRecord | null> {
  const rows = await tag<InviteRowSelect[]>`
    SELECT ${inviteColumns(tag)}
    FROM organization_invites i
    LEFT JOIN users iu ON iu.id = i.invited_by
    LEFT JOIN users au ON au.id = i.user_id
    WHERE i.id = ${inviteId}
    LIMIT 1
  `
  return rows[0] ? toInviteRecord(rows[0]) : null
}
