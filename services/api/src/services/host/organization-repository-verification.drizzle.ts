import { AppError, type OrgVerificationKind, type OrgVerificationStatus } from "@civfix/shared"
import type { Queryable, Sql } from "../../db/client.js"
import { encodeTimeCursor, pageWith, parseTimeCursor } from "../../db/cursor-helpers.js"
import { likeContains } from "../../db/like.js"
import { mediaBoundElsewhere, uploadedByClaimant } from "../media-bindings.js"
import { userUploader } from "../media-uploader.js"
import { writeHostAudit } from "./host-audit.js"
import { adminActorOf } from "./organization-repository-rows.drizzle.js"
import type {
  AdminOrgListQuery,
  AdminOrgVerificationRecord,
  ApplyOrgVerificationArgs,
  DecideOrgVerificationArgs,
  DecideOrgVerificationOutcome,
  OrganizationRepository,
  OrgVerificationRecord,
} from "./organization-repository.types.js"

type VerificationDocuments = { mediaId?: string }[] | null | undefined

interface VerificationRowSelect {
  status: OrgVerificationStatus
  kind: OrgVerificationKind
  submitted_at: Date | null
  reviewed_at: Date | null
  rejection_reason: string | null
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

function toVerificationRecord(row: VerificationRowSelect): OrgVerificationRecord {
  return {
    status: row.status,
    kind: row.kind,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    rejectionReason: row.rejection_reason,
  }
}

function documentMediaIdsOf(documents: VerificationDocuments): string[] {
  const out: string[] = []
  for (const doc of documents ?? []) {
    if (typeof doc.mediaId === "string" && !out.includes(doc.mediaId)) out.push(doc.mediaId)
  }
  return out
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
    submittedBy: adminActorOf(
      row.submitted_by_id,
      row.submitted_by_name,
      row.submitted_by_handle,
      row.submitted_by_joined,
    ),
    reviewedBy: adminActorOf(
      row.reviewed_by_id,
      row.reviewed_by_name,
      row.reviewed_by_handle,
      row.reviewed_by_joined,
    ),
  }
}

async function claimVerificationDocumentsInTx(
  tx: Queryable,
  mediaIds: readonly string[],
  claimantUserId: string,
): Promise<void> {
  if (mediaIds.length === 0) return
  const claimed = await tx<{ id: string }[]>`
    UPDATE media_assets
    SET purpose = 'verification'
    WHERE id = ANY(${[...mediaIds]}::uuid[])
      AND report_id IS NULL AND post_id IS NULL AND chat_message_id IS NULL
      AND (status = 'ready' OR (status = 'validating' AND finalized_at IS NOT NULL))
      AND ${uploadedByClaimant(tx, [userUploader(claimantUserId)])}
      AND NOT (${mediaBoundElsewhere(tx, null)})
    RETURNING id
  `
  if (claimed.length !== new Set(mediaIds).size) {
    throw AppError.validation({ documents: "One or more documents are unavailable." })
  }
}

async function latestAdminVerification(
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

/**
 * A resubmission with no documents keeps the ones already on the open application; otherwise the
 * submitted set replaces it. `fresh` are the ids to claim, `dropped` the ones to release.
 */
function planVerificationDocuments(
  carriedDocuments: VerificationDocuments,
  submittedIds: readonly string[],
): { effective: string[]; fresh: string[]; dropped: string[] } {
  const carried = documentMediaIdsOf(carriedDocuments)
  const submitted = documentMediaIdsOf(submittedIds.map((mediaId) => ({ mediaId })))
  const effective = submitted.length === 0 ? carried : submitted
  return {
    effective,
    fresh: effective.filter((mediaId) => !carried.includes(mediaId)),
    dropped: carried.filter((mediaId) => !effective.includes(mediaId)),
  }
}

export function makeOrganizationVerificationMethods(
  sql: Sql,
): Pick<
  OrganizationRepository,
  | "applyVerificationTx"
  | "getVerification"
  | "adminListVerifications"
  | "adminGetVerification"
  | "adminGetVerifications"
  | "decideVerificationTx"
  | "scrubDecidedEins"
> {
  return {
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
        const { effective, fresh, dropped } = planVerificationDocuments(
          openRow?.documents,
          args.documentMediaIds,
        )
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
        await claimVerificationDocumentsInTx(tx, fresh, args.submittedBy)
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
      const statusFilter = query.status !== undefined ? sql`AND v.status = ${query.status}` : sql``
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
      return latestAdminVerification(sql, organizationId)
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
        const verified = args.decision === "verified"
        const grantedKind = verified ? (args.kind ?? open.kind) : open.kind
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
              verified_kind = ${verified ? grantedKind : null},
              verified_at = ${verified ? args.now : null},
              updated_at = ${args.now}
          WHERE id = ${args.organizationId}
        `
        await writeHostAudit(tx, {
          actorId: args.reviewedBy,
          action: verified ? "org.verification_verified" : "org.verification_rejected",
          target: `organization:${args.organizationId}`,
          meta: { kind: grantedKind, reason: args.reason },
        })
        return "decided"
      })
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
