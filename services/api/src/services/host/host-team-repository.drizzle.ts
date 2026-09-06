import type { CleanupMemberRole, EventTeamInviteStatus, EventTeamRole } from "@civfix/shared"
import type { Queryable, Sql } from "../../db/client.js"
import { writeHostAudit } from "./host-audit.js"
import { isUniqueViolationOn } from "./registration-sql.js"
import type {
  AcceptTeamInviteOutcome,
  CreateTeamInviteArgs,
  CreateTeamInviteOutcome,
  EventTeamInviteRecord,
  EventTeamMemberRecord,
  HostTeamRepository,
  RevokeTeamInviteOutcome,
} from "./host-team-repository.types.js"

interface InviteRowSelect {
  id: string
  cleanup_id: string
  role: EventTeamRole
  status: EventTeamInviteStatus
  invited_email: string | null
  created_at: Date
  expires_at: Date
  accepted_at: Date | null
  invitee_id: string | null
  invitee_name: string | null
  invitee_handle: string | null
  inviter_id: string | null
  inviter_name: string | null
  inviter_handle: string | null
}

function inviteColumns(sql: Queryable) {
  return sql`
    i.id,
    i.cleanup_id,
    i.role,
    i.status,
    i.invited_email,
    i.created_at,
    i.expires_at,
    i.accepted_at,
    iu.id AS invitee_id,
    iu.display_name AS invitee_name,
    iu.handle AS invitee_handle,
    bu.id AS inviter_id,
    bu.display_name AS inviter_name,
    bu.handle AS inviter_handle
  `
}

function toInviteRecord(row: InviteRowSelect): EventTeamInviteRecord {
  return {
    id: row.id,
    cleanupId: row.cleanup_id,
    role: row.role,
    status: row.status,
    invitee:
      row.invitee_id === null
        ? null
        : {
            id: row.invitee_id,
            displayName: row.invitee_name ?? "Unknown",
            handle: row.invitee_handle,
            bio: null,
          },
    invitedEmail: row.invited_email,
    invitedBy:
      row.inviter_id === null
        ? null
        : {
            id: row.inviter_id,
            displayName: row.inviter_name ?? "Unknown",
            handle: row.inviter_handle,
            bio: null,
          },
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
  }
}

const TEAM_INVITE_PENDING_CONSTRAINTS = [
  "cleanup_team_invites_pending_user_uidx",
  "cleanup_team_invites_pending_email_uidx",
]

export function makeDrizzleHostTeamRepository(sql: Sql): HostTeamRepository {
  return {
    async listTeam(cleanupId: string, limit: number): Promise<EventTeamMemberRecord[]> {
      const rows = await sql<
        {
          id: string
          display_name: string
          handle: string | null
          bio: string | null
          verified: boolean
          role: CleanupMemberRole
          joined_at: Date | null
        }[]
      >`
        SELECT u.id, u.display_name, u.handle, u.bio, m.role, m.joined_at,
               EXISTS (
                 SELECT 1 FROM user_verification v
                 WHERE v.user_id = u.id AND v.status = 'verified'
               ) AS verified
        FROM cleanup_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.cleanup_id = ${cleanupId} AND m.role <> 'member'
        ORDER BY
          CASE m.role WHEN 'organizer' THEN 0 WHEN 'cohost' THEN 1 ELSE 2 END,
          m.joined_at ASC NULLS FIRST,
          u.id ASC
        LIMIT ${limit}
      `
      return rows.map((r) => ({
        person: {
          id: r.id,
          displayName: r.display_name,
          handle: r.handle,
          bio: r.bio,
          verified: r.verified,
        },
        role: r.role,
        joinedAt: r.joined_at,
      }))
    },

    async listInvites(cleanupId: string, limit: number): Promise<EventTeamInviteRecord[]> {
      const rows = await sql<InviteRowSelect[]>`
        SELECT ${inviteColumns(sql)}
        FROM cleanup_team_invites i
        LEFT JOIN users iu ON iu.id = i.invited_user_id
        LEFT JOIN users bu ON bu.id = i.invited_by
        WHERE i.cleanup_id = ${cleanupId} AND i.status = 'pending'
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT ${limit}
      `
      return rows.map(toInviteRecord)
    },

    async countPendingInvites(cleanupId: string): Promise<number> {
      const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM cleanup_team_invites
        WHERE cleanup_id = ${cleanupId} AND status = 'pending'
      `
      return rows[0]?.count ?? 0
    },

    async resolveUserByHandle(
      handle: string,
    ): Promise<{ userId: string; email: string | null } | null> {
      const rows = await sql<{ id: string; email: string | null }[]>`
        SELECT id, email FROM users
        WHERE handle = ${handle} AND deleted_at IS NULL
        LIMIT 1
      `
      const row = rows[0]
      return row === undefined ? null : { userId: row.id, email: row.email }
    },

    async createInviteTx(args: CreateTeamInviteArgs): Promise<CreateTeamInviteOutcome> {
      try {
        return await sql.begin(async (tx) => {
          const event = await tx<{ status: string }[]>`
            SELECT status FROM cleanups WHERE id = ${args.cleanupId} LIMIT 1 FOR SHARE
          `
          const status = event[0]?.status
          if (status === undefined || status === "cancelled" || status === "done") {
            return { kind: "closed" }
          }
          if (args.invitedUserId !== null) {
            const existing = await tx<{ role: CleanupMemberRole }[]>`
              SELECT role FROM cleanup_members
              WHERE cleanup_id = ${args.cleanupId} AND user_id = ${args.invitedUserId}
              LIMIT 1
            `
            const member = existing[0]
            if (member !== undefined && member.role !== "member") {
              return { kind: "already_member", role: member.role }
            }
            const banned = await tx<{ one: number }[]>`
              SELECT 1 AS one FROM cleanup_bans
              WHERE cleanup_id = ${args.cleanupId} AND user_id = ${args.invitedUserId}
              LIMIT 1
            `
            if (banned.length > 0) return { kind: "banned" }
          }
          const open = await tx<{ id: string }[]>`
            SELECT id FROM cleanup_team_invites
            WHERE cleanup_id = ${args.cleanupId}
              AND status = 'pending'
              AND (
                (invited_user_id IS NOT NULL AND invited_user_id = ${args.invitedUserId})
                OR (invited_email IS NOT NULL AND invited_email = ${args.invitedEmail})
              )
            LIMIT 1
          `
          if (open.length > 0) return { kind: "already_invited" }
          const inserted = await tx<InviteRowSelect[]>`
            WITH ins AS (
              INSERT INTO cleanup_team_invites (
                id, cleanup_id, invited_user_id, invited_email, role, token_hash, status,
                invited_by, expires_at, created_at
              ) VALUES (
                ${args.inviteId},
                ${args.cleanupId},
                ${args.invitedUserId},
                ${args.invitedEmail},
                ${args.role},
                ${args.tokenHash},
                'pending',
                ${args.invitedBy},
                ${args.expiresAt},
                ${args.now}
              )
              RETURNING *
            )
            SELECT ${inviteColumns(tx)}
            FROM ins i
            LEFT JOIN users iu ON iu.id = i.invited_user_id
            LEFT JOIN users bu ON bu.id = i.invited_by
          `
          const row = inserted[0]
          if (row === undefined) return { kind: "already_invited" }
          await writeHostAudit(tx, {
            actorId: args.invitedBy,
            action: "event.team_invited",
            target: `cleanup:${args.cleanupId}`,
            meta: {
              inviteId: args.inviteId,
              role: args.role,
              invitedUserId: args.invitedUserId,
              byEmail: args.invitedEmail !== null,
            },
          })
          return { kind: "created", invite: toInviteRecord(row) }
        })
      } catch (err) {
        if (isUniqueViolationOn(err, ...TEAM_INVITE_PENDING_CONSTRAINTS)) {
          return { kind: "already_invited" }
        }
        throw err
      }
    },

    async revokeInviteTx(args: {
      cleanupId: string
      inviteId: string
      actorId: string
    }): Promise<RevokeTeamInviteOutcome> {
      return sql.begin(async (tx) => {
        const revoked = await tx<{ id: string }[]>`
          UPDATE cleanup_team_invites
          SET status = 'revoked', invited_email = NULL, email_scrubbed_at = now()
          WHERE id = ${args.inviteId} AND cleanup_id = ${args.cleanupId} AND status = 'pending'
          RETURNING id
        `
        if (revoked.length === 0) return "not_found"
        await writeHostAudit(tx, {
          actorId: args.actorId,
          action: "event.team_invite_revoked",
          target: `cleanup:${args.cleanupId}`,
          meta: { inviteId: args.inviteId },
        })
        return "revoked"
      })
    },

    async acceptInviteTx(args: {
      cleanupId: string
      tokenHash: string
      userId: string
      now: Date
    }): Promise<AcceptTeamInviteOutcome> {
      return sql.begin(async (tx) => {
        const event = await tx<{ status: string }[]>`
          SELECT status FROM cleanups WHERE id = ${args.cleanupId} LIMIT 1 FOR SHARE
        `
        const status = event[0]?.status
        if (status === undefined) return { kind: "invalid" }
        if (status === "cancelled" || status === "done") return { kind: "closed" }
        const rows = await tx<
          {
            id: string
            role: EventTeamRole
            status: EventTeamInviteStatus
            invited_user_id: string | null
            invited_email: string | null
            expires_at: Date
          }[]
        >`
          SELECT id, role, status, invited_user_id, invited_email, expires_at
          FROM cleanup_team_invites
          WHERE token_hash = ${args.tokenHash} AND cleanup_id = ${args.cleanupId}
          LIMIT 1
          FOR UPDATE
        `
        const invite = rows[0]
        if (invite === undefined || invite.status !== "pending") return { kind: "invalid" }
        if (invite.expires_at.getTime() <= args.now.getTime()) {
          await tx`
            UPDATE cleanup_team_invites
            SET status = 'expired', invited_email = NULL, email_scrubbed_at = now()
            WHERE id = ${invite.id}
          `
          return { kind: "expired" }
        }
        if (invite.invited_user_id !== null && invite.invited_user_id !== args.userId) {
          return { kind: "wrong_recipient" }
        }
        if (invite.invited_user_id === null && invite.invited_email !== null) {
          const match = await tx<{ one: number }[]>`
            SELECT 1 AS one FROM users
            WHERE id = ${args.userId}
              AND email = ${invite.invited_email}
              AND email_verified = true
              AND deleted_at IS NULL
            LIMIT 1
          `
          if (match.length === 0) return { kind: "wrong_recipient" }
        }
        const banned = await tx<{ one: number }[]>`
          SELECT 1 AS one FROM cleanup_bans
          WHERE cleanup_id = ${args.cleanupId} AND user_id = ${args.userId}
          LIMIT 1
        `
        if (banned.length > 0) return { kind: "banned" }
        const held = await tx<{ role: CleanupMemberRole }[]>`
          SELECT role FROM cleanup_members
          WHERE cleanup_id = ${args.cleanupId} AND user_id = ${args.userId}
          LIMIT 1
        `
        await tx`
          INSERT INTO cleanup_members (cleanup_id, user_id, role, joined_at)
          VALUES (${args.cleanupId}, ${args.userId}, ${invite.role}, ${args.now})
          ON CONFLICT (cleanup_id, user_id)
          DO UPDATE SET role = CASE
            WHEN (CASE cleanup_members.role
                    WHEN 'organizer' THEN 4 WHEN 'cohost' THEN 3 WHEN 'staff' THEN 2 ELSE 1 END)
               >= (CASE EXCLUDED.role
                    WHEN 'organizer' THEN 4 WHEN 'cohost' THEN 3 WHEN 'staff' THEN 2 ELSE 1 END)
            THEN cleanup_members.role
            ELSE EXCLUDED.role
          END
          WHERE cleanup_members.role <> 'organizer'
        `
        await tx`
          UPDATE cleanup_team_invites
          SET status = 'accepted',
              accepted_at = ${args.now},
              accepted_by = ${args.userId},
              invited_email = NULL,
              email_scrubbed_at = now()
          WHERE id = ${invite.id}
        `
        await writeHostAudit(tx, {
          actorId: args.userId,
          action: "event.team_role_changed",
          target: `cleanup:${args.cleanupId}`,
          meta: {
            inviteId: invite.id,
            targetUserId: args.userId,
            from: held[0]?.role ?? null,
            to: invite.role,
          },
        })
        const current = await tx<{ role: CleanupMemberRole }[]>`
          SELECT role FROM cleanup_members
          WHERE cleanup_id = ${args.cleanupId} AND user_id = ${args.userId}
          LIMIT 1
        `
        return { kind: "accepted", role: current[0]?.role ?? invite.role }
      })
    },

    async scrubInviteEmails(before: Date, limit: number): Promise<number> {
      const rows = await sql<{ id: string }[]>`
        UPDATE cleanup_team_invites SET invited_email = NULL, email_scrubbed_at = now()
        WHERE id IN (
          SELECT id FROM cleanup_team_invites
          WHERE invited_email IS NOT NULL
            AND email_scrubbed_at IS NULL
            AND expires_at < ${before}
          ORDER BY expires_at ASC
          LIMIT ${limit}
        )
        RETURNING id
      `
      return rows.length
    },

    async expireStaleInvites(now: Date, limit: number): Promise<number> {
      const rows = await sql<{ id: string }[]>`
        UPDATE cleanup_team_invites SET status = 'expired'
        WHERE id IN (
          SELECT id FROM cleanup_team_invites
          WHERE status = 'pending' AND expires_at < ${now}
          ORDER BY expires_at ASC
          LIMIT ${limit}
        )
        RETURNING id
      `
      return rows.length
    },
  }
}
