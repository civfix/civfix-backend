import { AppError } from "@civfix/shared"
import type { Queryable, Sql, SqlFragment } from "../../db/client.js"
import { uploadedByClaimant } from "../media-bindings.js"
import { userUploader } from "../media-uploader.js"
import { writeHostAudit } from "./host-audit.js"
import {
  organizationColumns,
  readOrgHours,
  toOrganizationRecord,
  type OrganizationRowSelect,
} from "./organization-repository-rows.drizzle.js"
import type {
  CreateOrganizationArgs,
  OrganizationRecord,
  OrganizationRepository,
  UpdateOrganizationAudit,
  UpdateOrganizationOutcome,
  UpdateOrganizationPatch,
} from "./organization-repository.types.js"
import { isUniqueViolationOn } from "../../db/pg-errors.js"

/** The citext unique index on organizations.slug (0105). */
const ORG_SLUG_INDEX = "organizations_slug_uidx"

/**
 * A unique violation is only "slug taken" when it is THAT index. postgres.js surfaces the violated
 * index/constraint on `constraint_name`; any other unique violation inside the transaction (the owner
 * partial index, a media claim, ...) is a bug to surface, not a 409 to hand the caller.
 */
function isSlugTaken(err: unknown): boolean {
  return isUniqueViolationOn(err, ORG_SLUG_INDEX)
}

async function claimOrgLogoInTx(
  tx: Queryable,
  organizationId: string,
  logoMediaId: string | null,
  claimantUserId: string,
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
        OR (${uploadedByClaimant(tx, [userUploader(claimantUserId)])})
      )
    RETURNING id
  `
  if (claimed.length !== 1) {
    throw AppError.validation({ logoMediaId: "That image is unavailable." })
  }
}

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
  const row = rows[0]
  if (row === undefined) return null
  const hours = await readOrgHours(tag, [row.id])
  return toOrganizationRecord(row, hours.get(row.id))
}

/**
 * An operator-created verified org gets the same decided verification row + audit entry a
 * self-submitted application would end with, so adminGetOrg.verification and the audit trail read
 * identically whichever path verified it (DECISIONS §32).
 */
async function recordOperatorVerificationInTx(
  tx: Queryable,
  args: CreateOrganizationArgs,
  verifiedKind: NonNullable<CreateOrganizationArgs["verifiedKind"]>,
): Promise<void> {
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
    meta: {
      kind: verifiedKind,
      reason: args.operatorReason ?? null,
      source: "operator_create",
    },
  })
}

function organizationPatchSet(sql: Sql, patch: UpdateOrganizationPatch, now: Date) {
  const sets: SqlFragment[] = [sql`updated_at = ${now}`]
  if (patch.name !== undefined) sets.push(sql`name = ${patch.name}`)
  if (patch.slug !== undefined) sets.push(sql`slug = ${patch.slug}`)
  if (patch.description !== undefined) sets.push(sql`description = ${patch.description}`)
  if (patch.websiteUrl !== undefined) sets.push(sql`website_url = ${patch.websiteUrl}`)
  if (patch.donationUrl !== undefined) sets.push(sql`donation_url = ${patch.donationUrl}`)
  if (patch.logoMediaId !== undefined) sets.push(sql`logo_media_id = ${patch.logoMediaId}`)
  if (patch.socialLinks !== undefined) {
    sets.push(
      sql`social_links = ${patch.socialLinks === null ? null : sql.json(patch.socialLinks)}`,
    )
  }
  return sets.reduce((acc, frag, i) => (i === 0 ? frag : sql`${acc}, ${frag}`))
}

export function makeOrganizationProfileMethods(
  sql: Sql,
): Pick<
  OrganizationRepository,
  | "createOrganizationTx"
  | "findOrganizationById"
  | "findOrganizationBySlug"
  | "listMyOrganizations"
  | "updateOrganizationTx"
> {
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
          await claimOrgLogoInTx(tx, args.organizationId, args.logoMediaId, args.createdBy)
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
          if (verifiedKind !== null) await recordOperatorVerificationInTx(tx, args, verifiedKind)
          const created = await readById(tx, args.organizationId, ownerUserId)
          if (created === null) throw AppError.internal()
          return created
        })
      } catch (err) {
        if (isSlugTaken(err)) return "slug_taken"
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
      const row = rows[0]
      if (row === undefined) return null
      const hours = await readOrgHours(sql, [row.id])
      return toOrganizationRecord(row, hours.get(row.id))
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
      const hours = await readOrgHours(
        sql,
        rows.map((row) => row.id),
      )
      return rows.map((row) => toOrganizationRecord(row, hours.get(row.id)))
    },

    async updateOrganizationTx(
      id: string,
      patch: UpdateOrganizationPatch,
      now: Date,
      actorId: string,
      audit?: UpdateOrganizationAudit,
    ): Promise<UpdateOrganizationOutcome> {
      const setList = organizationPatchSet(sql, patch, now)
      try {
        return await sql.begin(async (tx): Promise<UpdateOrganizationOutcome> => {
          const updated = await tx<{ id: string }[]>`
            UPDATE organizations SET ${setList}
            WHERE id = ${id} AND deleted_at IS NULL
            RETURNING id
          `
          if (updated.length === 0) return "not_found"
          await claimOrgLogoInTx(tx, id, patch.logoMediaId ?? null, actorId)
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
  }
}
