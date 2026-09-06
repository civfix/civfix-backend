import type {
  OrganizationMemberRole,
  OrgVerificationKind,
  OrgVerificationStatus,
  SocialLinks,
} from "@civfix/shared"
import { AppError } from "@civfix/shared"
import type postgres from "postgres"
import type { Queryable, Sql } from "../../db/client.js"
import { encodeTimeCursor, pageWith, parseTimeCursor } from "../../db/cursor-helpers.js"
import { likeContains } from "../admin/like.js"
import { servedKeyExpr } from "../media-served-key.js"
import { upsertOrgEligibilityEin } from "../payments/eligibility-repository.drizzle.js"
import { normalizeEin } from "../payments/eligibility-sources.js"
import { MEDIA_CLAIM_WINDOW_SEC } from "./event-media.js"
import { mediaBoundElsewhere } from "../media-bindings.js"
import { writeHostAudit } from "./host-audit.js"
import type {
  AddOrganizationMemberOutcome,
  AdminOrgListQuery,
  AdminOrgVerificationRecord,
  ApplyOrgVerificationArgs,
  CreateOrganizationArgs,
  DecideOrgVerificationArgs,
  DecideOrgVerificationOutcome,
  OrganizationMemberRecord,
  OrganizationRecord,
  OrganizationRepository,
  OrgMemberIdentifier,
  OrgVerificationRecord,
  RemoveOrganizationMemberOutcome,
  SetOrganizationMemberRoleOutcome,
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
  deleted_at: Date | null
  member_count: number
  event_count: number
  my_role: OrganizationMemberRole | null
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
    deletedAt: row.deleted_at,
    memberCount: Number(row.member_count),
    eventCount: Number(row.event_count),
    myRole: row.my_role,
  }
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
    o.deleted_at,
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
      try {
        return await sql.begin(async (tx) => {
          await tx`
            INSERT INTO organizations (
              id, slug, name, description, website_url, logo_media_id, social_links,
              created_by, created_at, updated_at
            ) VALUES (
              ${args.organizationId},
              ${args.slug},
              ${args.name},
              ${args.description},
              ${args.websiteUrl},
              ${args.logoMediaId},
              ${args.socialLinks === null ? null : tx.json(args.socialLinks)},
              ${args.createdBy},
              ${args.now},
              ${args.now}
            )
          `
          await tx`
            INSERT INTO organization_members (organization_id, user_id, role, joined_at)
            VALUES (${args.organizationId}, ${args.createdBy}, 'owner', ${args.now})
          `
          await claimOrgLogoInTx(tx, args.organizationId, args.logoMediaId)
          const created = await readById(tx, args.organizationId, args.createdBy)
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
    ): Promise<boolean> {
      const sets: postgres.Fragment[] = [sql`updated_at = ${now}`]
      if (patch.name !== undefined) sets.push(sql`name = ${patch.name}`)
      if (patch.description !== undefined) sets.push(sql`description = ${patch.description}`)
      if (patch.websiteUrl !== undefined) sets.push(sql`website_url = ${patch.websiteUrl}`)
      if (patch.logoMediaId !== undefined) sets.push(sql`logo_media_id = ${patch.logoMediaId}`)
      if (patch.socialLinks !== undefined) {
        sets.push(
          sql`social_links = ${patch.socialLinks === null ? null : sql.json(patch.socialLinks)}`,
        )
      }
      const setList = sets.reduce((acc, frag, i) => (i === 0 ? frag : sql`${acc}, ${frag}`))
      return sql.begin(async (tx) => {
        const updated = await tx<{ id: string }[]>`
          UPDATE organizations SET ${setList}
          WHERE id = ${id} AND deleted_at IS NULL
          RETURNING id
        `
        if (updated.length === 0) return false
        await claimOrgLogoInTx(tx, id, patch.logoMediaId ?? null)
        return true
      })
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
          verified: boolean
          role: OrganizationMemberRole
          joined_at: Date
        }[]
      >`
        SELECT m.user_id, u.display_name, u.handle, u.bio, m.role, m.joined_at,
               EXISTS (
                 SELECT 1 FROM user_verification v
                 WHERE v.user_id = u.id AND v.status = 'verified'
               ) AS verified
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
            verified: r.verified,
          },
          role: r.role,
          joinedAt: r.joined_at,
        })),
        args.limit,
        (last) => encodeTimeCursor({ at: last.joinedAt, id: last.person.id }),
      )
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
        await writeHostAudit(tx, {
          actorId: args.actorId,
          action: "org.member_removed",
          target: `organization:${args.organizationId}`,
          meta: { targetUserId: args.userId, role: removed[0]?.role ?? null },
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
