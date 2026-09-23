import type { OrganizationMemberRole } from "@civfix/shared"
import type { Queryable, Sql } from "../../db/client.js"
import {
  keysetInstant,
  keysetPredicate,
  paginateKeyset,
  parseKeysetCursor,
} from "../../db/cursor-helpers.js"
import { writeHostAudit } from "./host-audit.js"
import type {
  AddOrganizationMemberOutcome,
  AdminActorView,
  AdminAddMemberArgs,
  AdminAddMemberOutcome,
  AdminOrgMemberRecord,
  AdminSetMemberRoleArgs,
  AdminSetMemberRoleOutcome,
  InviterRevocationReason,
  OrganizationMemberRecord,
  OrganizationOwnerRecord,
  OrganizationRepository,
  OrgMemberIdentifier,
  RemoveOrganizationMemberOutcome,
  SetOrganizationMemberRoleOutcome,
} from "./organization-repository.js"
import { canManageOrgMembers, roleChangeWithdrawsInvites } from "./organization-repository.js"

interface MemberRowSelect {
  user_id: string
  display_name: string
  handle: string | null
  bio: string | null
  avatar_url: string | null
  role: OrganizationMemberRole
  joined_at: Date
}

function toMemberRecord(r: MemberRowSelect): OrganizationMemberRecord {
  return {
    person: {
      id: r.user_id,
      displayName: r.display_name,
      handle: r.handle,
      bio: r.bio,
      avatarUrl: r.avatar_url,
    },
    role: r.role,
    joinedAt: r.joined_at,
  }
}

async function countAdminSeats(tx: Queryable, organizationId: string): Promise<number> {
  const rows = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM organization_members
    WHERE organization_id = ${organizationId} AND role IN ('owner','admin')
  `
  return rows[0]?.n ?? 0
}

/**
 * Every role change and removal takes the organizations row lock first, so re-reading the actor's
 * role under it sees the latest committed seat. FOR SHARE also holds off an account erasure, which
 * deletes seats without the organization lock.
 */
export async function lockOrgForActorIn(
  tx: Queryable,
  organizationId: string,
  actorId: string,
): Promise<boolean> {
  await tx`
    SELECT id FROM organizations WHERE id = ${organizationId} LIMIT 1 FOR UPDATE
  `
  const rows = await tx<{ role: OrganizationMemberRole }[]>`
    SELECT role FROM organization_members
    WHERE organization_id = ${organizationId} AND user_id = ${actorId}
    LIMIT 1
    FOR SHARE
  `
  return canManageOrgMembers(rows[0]?.role ?? null)
}

async function lockOrganizationInTx(tx: Queryable, organizationId: string): Promise<void> {
  await tx`
    SELECT id FROM organizations WHERE id = ${organizationId} LIMIT 1 FOR UPDATE
  `
}

async function lockMemberRoleInTx(
  tx: Queryable,
  organizationId: string,
  userId: string,
): Promise<OrganizationMemberRole | undefined> {
  const rows = await tx<{ role: OrganizationMemberRole }[]>`
    SELECT role FROM organization_members
    WHERE organization_id = ${organizationId} AND user_id = ${userId}
    LIMIT 1
    FOR UPDATE
  `
  return rows[0]?.role
}

async function updateMemberRoleInTx(
  tx: Queryable,
  args: { organizationId: string; userId: string; role: OrganizationMemberRole },
): Promise<void> {
  await tx`
    UPDATE organization_members SET role = ${args.role}
    WHERE organization_id = ${args.organizationId} AND user_id = ${args.userId}
  `
}

/** The caller already holds the organizations row lock, so this keeps the documented lock order. */
async function revokeInvitesByInviterInTx(
  tx: Queryable,
  args: {
    organizationId: string
    inviterId: string
    actorId: string
    reason: InviterRevocationReason
  },
): Promise<void> {
  await tx`
    WITH revoked AS (
      UPDATE organization_invites
      SET status = 'revoked', revoked_at = now()
      WHERE organization_id = ${args.organizationId}
        AND invited_by = ${args.inviterId}
        AND status = 'pending'
      RETURNING id
    )
    INSERT INTO audit_log (actor_id, action, target, meta)
    SELECT ${args.actorId}::uuid, 'org.invite_revoked', ${`organization:${args.organizationId}`},
           jsonb_build_object('inviteId', id, 'reason', ${args.reason}::text)
    FROM revoked
  `
}

/**
 * Ownership transfer: exactly one owner per org (partial unique index), so the current owner steps
 * down to admin in the same transaction before the new owner is seated. Returns the previous owner.
 */
async function demoteOwnerInTx(tx: Queryable, organizationId: string): Promise<string | null> {
  const demoted = await tx<{ user_id: string }[]>`
    UPDATE organization_members SET role = 'admin'
    WHERE organization_id = ${organizationId} AND role = 'owner'
    RETURNING user_id
  `
  return demoted[0]?.user_id ?? null
}

async function auditOwnershipTransferInTx(
  tx: Queryable,
  args: { organizationId: string; actorId: string; to: string; reason: string },
  previousOwner: string | null,
): Promise<void> {
  await writeHostAudit(tx, {
    actorId: args.actorId,
    action: "org.ownership_transferred",
    target: `organization:${args.organizationId}`,
    meta: { from: previousOwner, to: args.to, reason: args.reason },
  })
}

export function makeOrganizationMemberMethods(
  sql: Sql,
): Pick<
  OrganizationRepository,
  | "roleOf"
  | "listMembers"
  | "findMember"
  | "findOwner"
  | "findUser"
  | "resolveUserByIdentifier"
  | "addMemberTx"
  | "setMemberRoleTx"
  | "removeMemberTx"
  | "adminListMembers"
  | "adminAddMemberTx"
  | "adminSetMemberRoleTx"
> {
  function memberCursorFilter(raw: string | null) {
    const cursor = parseKeysetCursor(raw, { direction: "asc" })
    return cursor === null
      ? sql``
      : sql`AND ${keysetPredicate(sql, sql`m.joined_at`, sql`m.user_id`, cursor, { direction: "asc" })}`
  }

  return {
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
      const rows = await sql<(MemberRowSelect & { cursor_at: string })[]>`
        SELECT m.user_id, u.display_name, u.handle, u.bio, u.avatar_url, m.role, m.joined_at,
               ${keysetInstant(sql, sql`m.joined_at`)} AS cursor_at
        FROM organization_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${args.organizationId}
          ${memberCursorFilter(args.cursor)}
        ORDER BY m.joined_at ASC, m.user_id ASC
        LIMIT ${args.limit + 1}
      `
      const page = paginateKeyset(rows, args.limit, (last) => ({
        atText: last.cursor_at,
        id: last.user_id,
      }))
      return { items: page.items.map(toMemberRecord), nextCursor: page.nextCursor }
    },

    async findMember(
      organizationId: string,
      userId: string,
    ): Promise<OrganizationMemberRecord | null> {
      const rows = await sql<MemberRowSelect[]>`
        SELECT m.user_id, u.display_name, u.handle, u.bio, u.avatar_url, m.role, m.joined_at
        FROM organization_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${organizationId} AND m.user_id = ${userId}
        LIMIT 1
      `
      const r = rows[0]
      return r === undefined ? null : toMemberRecord(r)
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
      return sql.begin(async (tx): Promise<AddOrganizationMemberOutcome> => {
        if (!(await lockOrgForActorIn(tx, args.organizationId, args.actorId))) return "forbidden"
        const inserted = await tx<{ user_id: string }[]>`
          INSERT INTO organization_members (organization_id, user_id, role, joined_at)
          VALUES (${args.organizationId}, ${args.userId}, ${args.role}, ${args.now})
          ON CONFLICT (organization_id, user_id) DO NOTHING
          RETURNING user_id
        `
        if (inserted.length === 0) return "already_member"
        await writeHostAudit(tx, {
          actorId: args.actorId,
          action: "org.member_added",
          target: `organization:${args.organizationId}`,
          meta: { targetUserId: args.userId, role: args.role, via: "handle" },
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
        await lockOrganizationInTx(tx, args.organizationId)
        const existing = await lockMemberRoleInTx(tx, args.organizationId, args.userId)
        if (existing === undefined) return "not_member"
        if (existing === "owner") return "owner"
        if (existing === args.role) return "updated"
        if (existing === "admin" && args.role === "member") {
          const seats = await countAdminSeats(tx, args.organizationId)
          if (seats <= 1) return "last_admin"
        }
        await updateMemberRoleInTx(tx, args)
        await writeHostAudit(tx, {
          actorId: args.actorId,
          action: "org.member_role_changed",
          target: `organization:${args.organizationId}`,
          meta: { targetUserId: args.userId, from: existing, to: args.role },
        })
        if (roleChangeWithdrawsInvites(existing, args.role)) {
          await revokeInvitesByInviterInTx(tx, {
            organizationId: args.organizationId,
            inviterId: args.userId,
            actorId: args.actorId,
            reason: "inviter_demoted",
          })
        }
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
        await lockOrganizationInTx(tx, args.organizationId)
        await tx`
          SELECT id FROM users WHERE id = ${args.userId} LIMIT 1 FOR UPDATE
        `
        const targetRole = await lockMemberRoleInTx(tx, args.organizationId, args.userId)
        if (targetRole === "admin") {
          const seats = await countAdminSeats(tx, args.organizationId)
          if (seats <= 1) return "last_admin"
        }
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
        await revokeInvitesByInviterInTx(tx, {
          organizationId: args.organizationId,
          inviterId: args.userId,
          actorId: args.actorId,
          reason: "inviter_removed",
        })
        return "removed"
      })
    },

    async adminListMembers(args: {
      organizationId: string
      cursor: string | null
      limit: number
    }): Promise<{ items: AdminOrgMemberRecord[]; nextCursor: string | null }> {
      const rows = await sql<
        {
          user_id: string
          display_name: string
          handle: string
          created_at: Date
          role: OrganizationMemberRole
          joined_at: Date
          cursor_at: string
        }[]
      >`
        SELECT m.user_id, u.display_name, u.handle, u.created_at, m.role, m.joined_at,
               ${keysetInstant(sql, sql`m.joined_at`)} AS cursor_at
        FROM organization_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${args.organizationId}
          ${memberCursorFilter(args.cursor)}
        ORDER BY m.joined_at ASC, m.user_id ASC
        LIMIT ${args.limit + 1}
      `
      const page = paginateKeyset(rows, args.limit, (last) => ({
        atText: last.cursor_at,
        id: last.user_id,
      }))
      return {
        items: page.items.map((r) => ({
          user: { id: r.user_id, name: r.display_name, handle: r.handle, joined: r.created_at },
          role: r.role,
          joinedAt: r.joined_at,
        })),
        nextCursor: page.nextCursor,
      }
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
        const transfer = args.role === "owner"
        const previousOwner = transfer ? await demoteOwnerInTx(tx, args.organizationId) : null
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
        if (transfer) {
          await auditOwnershipTransferInTx(tx, { ...args, to: args.userId }, previousOwner)
        }
        return "added"
      })
    },

    async adminSetMemberRoleTx(args: AdminSetMemberRoleArgs): Promise<AdminSetMemberRoleOutcome> {
      return sql.begin(async (tx): Promise<AdminSetMemberRoleOutcome> => {
        await lockOrganizationInTx(tx, args.organizationId)
        const existing = await lockMemberRoleInTx(tx, args.organizationId, args.userId)
        if (existing === undefined) return "not_member"
        if (existing === args.role) return "updated"
        if (existing === "owner") return "sole_owner"
        const transfer = args.role === "owner"
        const previousOwner = transfer ? await demoteOwnerInTx(tx, args.organizationId) : null
        await updateMemberRoleInTx(tx, args)
        await writeHostAudit(tx, {
          actorId: args.actorId,
          action: "org.member_role_changed",
          target: `organization:${args.organizationId}`,
          meta: {
            targetUserId: args.userId,
            from: existing,
            to: args.role,
            reason: args.reason,
          },
        })
        if (roleChangeWithdrawsInvites(existing, args.role)) {
          await revokeInvitesByInviterInTx(tx, {
            organizationId: args.organizationId,
            inviterId: args.userId,
            actorId: args.actorId,
            reason: "inviter_demoted",
          })
        }
        if (transfer) {
          await auditOwnershipTransferInTx(tx, { ...args, to: args.userId }, previousOwner)
        }
        return "updated"
      })
    },
  }
}
