import {
  AppError,
  MAX_ORG_INVITES_PER_ORG,
  type OrganizationInviteRole,
  type OrganizationInviteStatus,
  type OrganizationMemberRole,
  type OrgVerificationKind,
  type OrgVerificationStatus,
} from "@civfix/shared"
import type { Queryable, Sql } from "../../db/client.js"
import { publicServedKeyExpr } from "../media-served-key.js"
import { writeHostAudit } from "./host-audit.js"
import { lockOrgForActorIn } from "./organization-members.drizzle.js"
import { personViewOf, UNKNOWN_PERSON_NAME } from "./organization-rows.drizzle.js"
import type {
  AcceptOrganizationInviteOutcome,
  CreateOrganizationInviteArgs,
  CreateOrganizationInviteOutcome,
  DeclineOrganizationInviteOutcome,
  InviterStanding,
  OrganizationInviteRecord,
  OrganizationRepository,
  PendingOrganizationInviteRecord,
  RevokeOrganizationInviteOutcome,
} from "./organization-repository.types.js"
import { inviterRevocationReason, ORG_INVITE_CAP_MESSAGE } from "./organization-repository.types.js"

type InviteLookup = { tokenHash: string } | { inviteId: string }

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
  user_avatar_url: string | null
  invited_by_id: string | null
  invited_by_name: string | null
  invited_by_handle: string | null
  invited_by_bio: string | null
  invited_by_avatar_url: string | null
}

interface PendingInviteForUserRowSelect {
  id: string
  role: OrganizationInviteRole
  created_at: Date
  expires_at: Date
  invited_by_id: string | null
  invited_by_name: string | null
  invited_by_handle: string | null
  invited_by_bio: string | null
  invited_by_avatar_url: string | null
  organization_id: string
  organization_slug: string
  organization_name: string
  organization_logo_key: string | null
  organization_verified_status: OrgVerificationStatus
  organization_verified_kind: OrgVerificationKind | null
}

interface LockedInviteRow {
  id: string
  email: string | null
  user_id: string | null
  role: OrganizationInviteRole
  status: OrganizationInviteStatus
  expires_at: Date
  invited_by: string | null
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
    au.avatar_url AS user_avatar_url,
    iu.id AS invited_by_id,
    iu.display_name AS invited_by_name,
    iu.handle AS invited_by_handle,
    iu.bio AS invited_by_bio,
    iu.avatar_url AS invited_by_avatar_url
  `
}

function inviterViewOf(row: InviteRowSelect | PendingInviteForUserRowSelect, fallbackName: string) {
  return personViewOf(
    {
      id: row.invited_by_id,
      name: row.invited_by_name,
      handle: row.invited_by_handle,
      bio: row.invited_by_bio,
      avatarUrl: row.invited_by_avatar_url,
    },
    fallbackName,
  )
}

function toInviteRecord(row: InviteRowSelect): OrganizationInviteRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    user: personViewOf(
      {
        id: row.user_id,
        name: row.user_name,
        handle: row.user_handle,
        bio: row.user_bio,
        avatarUrl: row.user_avatar_url,
      },
      UNKNOWN_PERSON_NAME,
    ),
    role: row.role,
    status: row.status,
    invitedBy: inviterViewOf(row, UNKNOWN_PERSON_NAME),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

function toPendingInviteForUser(
  row: PendingInviteForUserRowSelect,
): PendingOrganizationInviteRecord {
  return {
    id: row.id,
    role: row.role,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    invitedBy: inviterViewOf(row, ""),
    organization: {
      id: row.organization_id,
      slug: row.organization_slug,
      name: row.organization_name,
      logoKey: row.organization_logo_key,
      donationUrl: null,
      verifiedStatus: row.organization_verified_status,
      verifiedKind: row.organization_verified_kind,
      suspended: false,
    },
  }
}

async function readInvite(
  tag: Queryable,
  inviteId: string,
): Promise<OrganizationInviteRecord | null> {
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

async function requireInvite(tag: Queryable, inviteId: string): Promise<OrganizationInviteRecord> {
  const invite = await readInvite(tag, inviteId)
  if (invite === null) throw AppError.internal()
  return invite
}

async function countOpenInvites(
  tag: Queryable,
  organizationId: string,
  now: Date,
): Promise<number> {
  const rows = await tag<{ count: number }[]>`
    SELECT count(*)::int AS count FROM organization_invites
    WHERE organization_id = ${organizationId}
      AND status = 'pending'
      AND expires_at > ${now}
  `
  return Number(rows[0]?.count ?? 0)
}

async function expireInvitesInTx(tag: Queryable, organizationId: string, now: Date): Promise<void> {
  await tag`
    UPDATE organization_invites SET status = 'expired'
    WHERE organization_id = ${organizationId} AND status = 'pending' AND expires_at <= ${now}
  `
}

async function expireInviteInTx(tx: Queryable, inviteId: string): Promise<void> {
  await tx`UPDATE organization_invites SET status = 'expired' WHERE id = ${inviteId}`
}

async function inviterStandingIn(
  tx: Queryable,
  organizationId: string,
  inviterId: string | null,
): Promise<InviterStanding | null> {
  if (inviterId === null) return null
  const rows = await tx<{ role: OrganizationMemberRole | null; deleted: boolean }[]>`
    SELECT m.role, (u.deleted_at IS NOT NULL) AS deleted
    FROM users u
    LEFT JOIN organization_members m ON m.organization_id = ${organizationId} AND m.user_id = u.id
    WHERE u.id = ${inviterId}
    LIMIT 1
  `
  const row = rows[0]
  return row === undefined ? null : { role: row.role, deleted: row.deleted }
}

/**
 * The invite is a claim on the account that signs in with the invited address (verified), the same
 * rule cleanup_team_invites applies - never on whoever holds the link: the row must name this
 * account, or carry an address this account has verified.
 */
async function inviteAddressesUserInTx(
  tx: Queryable,
  invite: { user_id: string | null; email: string | null },
  userId: string,
): Promise<boolean> {
  if (invite.user_id !== null && invite.user_id === userId) return true
  if (invite.email === null) return false
  const rows = await tx<{ one: number }[]>`
    SELECT 1 AS one FROM users
    WHERE id = ${userId}
      AND email = ${invite.email}
      AND email_verified = true
      AND deleted_at IS NULL
    LIMIT 1
  `
  return rows.length > 0
}

async function findInviteRefInTx(
  tx: Queryable,
  by: InviteLookup,
): Promise<{ id: string; organization_id: string } | undefined> {
  const rows =
    "tokenHash" in by
      ? await tx<{ id: string; organization_id: string }[]>`
          SELECT id, organization_id FROM organization_invites
          WHERE token_hash = ${by.tokenHash}
          LIMIT 1
        `
      : await tx<{ id: string; organization_id: string }[]>`
          SELECT id, organization_id FROM organization_invites
          WHERE id = ${by.inviteId}
          LIMIT 1
        `
  return rows[0]
}

async function lockInvitedOrgInTx(
  tx: Queryable,
  organizationId: string,
): Promise<{ id: string; suspended: boolean } | undefined> {
  const rows = await tx<{ id: string; suspended: boolean }[]>`
    SELECT id, (suspended_at IS NOT NULL) AS suspended FROM organizations
    WHERE id = ${organizationId} AND deleted_at IS NULL
    LIMIT 1 FOR UPDATE
  `
  return rows[0]
}

async function lockInviteInTx(
  tx: Queryable,
  inviteId: string,
): Promise<LockedInviteRow | undefined> {
  const rows = await tx<LockedInviteRow[]>`
    SELECT id, email, user_id, role, status, expires_at, invited_by FROM organization_invites
    WHERE id = ${inviteId}
    LIMIT 1 FOR UPDATE
  `
  return rows[0]
}

// An invite seats on its inviter's authority, so one that outlived it is closed as revoked instead.
async function revokeIfInviterLapsedInTx(
  tx: Queryable,
  args: { organizationId: string; invite: LockedInviteRow; userId: string; now: Date },
): Promise<boolean> {
  const revocation = inviterRevocationReason(
    await inviterStandingIn(tx, args.organizationId, args.invite.invited_by),
  )
  if (revocation === null) return false
  await tx`
    UPDATE organization_invites
    SET status = 'revoked', revoked_at = ${args.now}
    WHERE id = ${args.invite.id}
  `
  await writeHostAudit(tx, {
    actorId: args.userId,
    action: "org.invite_revoked",
    target: `organization:${args.organizationId}`,
    meta: { inviteId: args.invite.id, reason: revocation },
  })
  return true
}

async function seatInviteeInTx(
  tx: Queryable,
  args: { organizationId: string; invite: LockedInviteRow; userId: string; now: Date },
): Promise<AcceptOrganizationInviteOutcome> {
  const inserted = await tx<{ user_id: string }[]>`
    INSERT INTO organization_members (organization_id, user_id, role, joined_at)
    VALUES (${args.organizationId}, ${args.userId}, ${args.invite.role}, ${args.now})
    ON CONFLICT (organization_id, user_id) DO NOTHING
    RETURNING user_id
  `
  const alreadyMember = inserted.length === 0
  // An existing member keeps the role they already hold: accepting an invite never upgrades
  // (or downgrades) a seat, it only closes the invite.
  let role: OrganizationMemberRole = args.invite.role
  if (alreadyMember) {
    const seated = await tx<{ role: OrganizationMemberRole }[]>`
      SELECT role FROM organization_members
      WHERE organization_id = ${args.organizationId} AND user_id = ${args.userId}
      LIMIT 1
    `
    role = seated[0]?.role ?? args.invite.role
  }
  await tx`
    UPDATE organization_invites
    SET status = 'accepted', accepted_at = ${args.now}, user_id = ${args.userId}
    WHERE id = ${args.invite.id}
  `
  await writeHostAudit(tx, {
    actorId: args.userId,
    action: "org.invite_accepted",
    target: `organization:${args.organizationId}`,
    meta: { inviteId: args.invite.id, role, alreadyMember },
  })
  return { kind: "accepted", organizationId: args.organizationId, role, alreadyMember }
}

export function makeOrganizationInviteMethods(
  sql: Sql,
): Pick<
  OrganizationRepository,
  | "countPendingInvites"
  | "createInviteTx"
  | "listInvites"
  | "revokeInviteTx"
  | "acceptInviteTx"
  | "listPendingInvitesForUser"
  | "declineInviteTx"
> {
  return {
    countPendingInvites(organizationId: string, now: Date): Promise<number> {
      return countOpenInvites(sql, organizationId, now)
    },

    async createInviteTx(
      args: CreateOrganizationInviteArgs,
    ): Promise<CreateOrganizationInviteOutcome> {
      return sql.begin(async (tx): Promise<CreateOrganizationInviteOutcome> => {
        // The organization row lock also serializes concurrent inviters on one org (this is the only
        // insert into organization_invites), so the cap below is counted, not raced.
        if (!(await lockOrgForActorIn(tx, args.organizationId, args.invitedBy))) {
          return { kind: "forbidden" }
        }
        await expireInvitesInTx(tx, args.organizationId, args.now)
        // The cap is checked before the idempotent re-invite path on purpose: it must not depend on
        // the address.
        if (
          (await countOpenInvites(tx, args.organizationId, args.now)) >= MAX_ORG_INVITES_PER_ORG
        ) {
          throw AppError.conflict(ORG_INVITE_CAP_MESSAGE)
        }
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
          return { kind: "already_invited", invite: await requireInvite(tx, openId) }
        }
        await writeHostAudit(tx, {
          actorId: args.invitedBy,
          action: "org.invite_created",
          target: `organization:${args.organizationId}`,
          meta: { inviteId: args.inviteId, role: args.role },
        })
        return { kind: "created", invite: await requireInvite(tx, args.inviteId) }
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
      const viewer = await sql<{ email: string | null }[]>`
        SELECT email FROM users
        WHERE id = ${args.userId} AND email_verified = true AND deleted_at IS NULL
        LIMIT 1
      `
      const verifiedEmail = viewer[0]?.email ?? null
      const addressed =
        verifiedEmail === null
          ? sql`i.user_id = ${args.userId}`
          : sql`(i.user_id = ${args.userId} OR i.email = ${verifiedEmail})`
      const rows = await sql<PendingInviteForUserRowSelect[]>`
        SELECT
          i.id,
          i.role,
          i.created_at,
          i.expires_at,
          iu.id AS invited_by_id,
          iu.display_name AS invited_by_name,
          iu.handle AS invited_by_handle,
          iu.bio AS invited_by_bio,
          iu.avatar_url AS invited_by_avatar_url,
          o.id AS organization_id,
          o.slug AS organization_slug,
          o.name AS organization_name,
          ${publicServedKeyExpr(sql, "am")} AS organization_logo_key,
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
          AND ${addressed}
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT ${args.limit}
      `
      return rows.map(toPendingInviteForUser)
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
        if (!(await inviteAddressesUserInTx(tx, invite, args.userId))) return "invalid"
        if (invite.expires_at.getTime() <= args.now.getTime()) {
          await expireInviteInTx(tx, invite.id)
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
      by: InviteLookup
      userId: string
      now: Date
    }): Promise<AcceptOrganizationInviteOutcome> {
      const byToken = "tokenHash" in args.by
      return sql.begin(async (tx): Promise<AcceptOrganizationInviteOutcome> => {
        const hit = await findInviteRefInTx(tx, args.by)
        if (hit === undefined) return { kind: "invalid" }
        // Lock order: organizations -> organization_members -> organization_invites.
        const org = await lockInvitedOrgInTx(tx, hit.organization_id)
        if (org === undefined) return { kind: "invalid" }
        const invite = await lockInviteInTx(tx, hit.id)
        if (invite === undefined || invite.status !== "pending") return { kind: "invalid" }
        // The id-addressed path has no token to prove anything, so the seat itself is the claim.
        // Addressing is decided BEFORE expiry, so a caller holding someone else's invite id never
        // learns that the invite exists.
        const addressed = await inviteAddressesUserInTx(tx, invite, args.userId)
        if (byToken ? invite.email !== null && !addressed : !addressed) {
          return { kind: "wrong_recipient" }
        }
        if (invite.expires_at.getTime() <= args.now.getTime()) {
          await expireInviteInTx(tx, invite.id)
          return { kind: "expired" }
        }
        const seat = { organizationId: org.id, invite, userId: args.userId, now: args.now }
        if (await revokeIfInviterLapsedInTx(tx, seat)) return { kind: "invalid" }
        if (org.suspended) return { kind: "suspended" }
        return seatInviteeInTx(tx, seat)
      })
    },
  }
}
