import {
  AppError,
  type CleanupMemberRole,
  type CleanupStatus,
  type EventTeamInviteStatus,
  type EventTeamRole,
  type EventVisibility,
} from "@civfix/shared"
import type { Queryable, Sql } from "../../db/client.js"
import { encodeTimeCursor, pageWith, parseTimeCursor } from "../../db/cursor-helpers.js"
import { publicServedKeyExpr } from "../media-served-key.js"
import { cleanupStatusExpr } from "../cleanup-sql.js"
import { writeHostAudit } from "./host-audit.js"
import { isUniqueViolationOn } from "./registration-sql.js"
import type {
  AcceptTeamInviteByIdOutcome,
  AcceptTeamInviteOutcome,
  CreateTeamInviteArgs,
  CreateTeamInviteOutcome,
  DeclineTeamInviteOutcome,
  EventTeamInviteRecord,
  EventTeamMemberRecord,
  HostTeamRepository,
  ListInvitesForUserArgs,
  OpenTeamInviteQuery,
  PendingInviteForUserRecord,
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
  invitee_avatar_url: string | null
  inviter_id: string | null
  inviter_name: string | null
  inviter_handle: string | null
  inviter_avatar_url: string | null
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
    iu.avatar_url AS invitee_avatar_url,
    bu.id AS inviter_id,
    bu.display_name AS inviter_name,
    bu.handle AS inviter_handle,
    bu.avatar_url AS inviter_avatar_url
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
            avatarUrl: row.invitee_avatar_url,
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
            avatarUrl: row.inviter_avatar_url,
          },
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
  }
}

interface PendingInviteForUserRowSelect {
  id: string
  role: EventTeamRole
  created_at: Date
  expires_at: Date
  event_id: string
  title: string
  scheduled_at: Date
  ends_at: Date | null
  event_status: CleanupStatus
  visibility: EventVisibility
  address: string | null
  cover_key: string | null
  inviter_id: string | null
  inviter_name: string | null
  inviter_handle: string | null
  inviter_avatar_url: string | null
}

function toPendingInviteForUser(row: PendingInviteForUserRowSelect): PendingInviteForUserRecord {
  return {
    id: row.id,
    role: row.role,
    event: {
      id: row.event_id,
      title: row.title,
      startsAt: row.scheduled_at,
      endsAt: row.ends_at,
      status: row.event_status,
      visibility: row.visibility,
      coverKey: row.cover_key,
      address: row.address,
    },
    invitedBy:
      row.inviter_id === null
        ? null
        : {
            id: row.inviter_id,
            displayName: row.inviter_name ?? "Unknown",
            handle: row.inviter_handle,
            bio: null,
            avatarUrl: row.inviter_avatar_url,
          },
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

const TEAM_INVITE_PENDING_CONSTRAINTS = [
  "cleanup_team_invites_pending_user_uidx",
  "cleanup_team_invites_pending_email_uidx",
]

async function readOpenInvite(
  tag: Queryable,
  args: OpenTeamInviteQuery,
): Promise<EventTeamInviteRecord | null> {
  const rows = await tag<InviteRowSelect[]>`
    SELECT ${inviteColumns(tag)}
    FROM cleanup_team_invites i
    LEFT JOIN users iu ON iu.id = i.invited_user_id
    LEFT JOIN users bu ON bu.id = i.invited_by
    WHERE i.cleanup_id = ${args.cleanupId}
      AND i.status = 'pending'
      AND (
        (i.invited_user_id IS NOT NULL AND i.invited_user_id = ${args.invitedUserId})
        OR (i.invited_email IS NOT NULL AND i.invited_email = ${args.invitedEmail})
      )
    ORDER BY i.created_at DESC, i.id DESC
    LIMIT 1
  `
  const row = rows[0]
  return row === undefined ? null : toInviteRecord(row)
}

async function reofferOpenInvite(
  tx: Queryable,
  args: CreateTeamInviteArgs,
): Promise<Extract<CreateTeamInviteOutcome, { kind: "already_invited" | "updated" }> | null> {
  const open = await readOpenInvite(tx, args)
  if (open === null) return null
  if (open.role === args.role) return { kind: "already_invited", invite: open }
  const rows = await tx<{ id: string }[]>`
    UPDATE cleanup_team_invites SET role = ${args.role}
    WHERE id = ${open.id} AND status = 'pending'
    RETURNING id
  `
  if (rows.length === 0) return { kind: "already_invited", invite: open }
  await writeHostAudit(tx, {
    actorId: args.invitedBy,
    action: "event.team_role_changed",
    target: `cleanup:${args.cleanupId}`,
    meta: { inviteId: open.id, from: open.role, to: args.role },
  })
  return { kind: "updated", invite: { ...open, role: args.role } }
}

async function eventOpenInTx(
  tx: Queryable,
  cleanupId: string,
): Promise<"open" | "closed" | "gone"> {
  const rows = await tx<{ closed: boolean }[]>`
    SELECT (status = 'cancelled' OR ends_at <= now()) AS closed
    FROM cleanups WHERE id = ${cleanupId} LIMIT 1 FOR SHARE
  `
  const row = rows[0]
  if (row === undefined) return "gone"
  return row.closed ? "closed" : "open"
}

async function alreadySeatedOutcome(
  tag: Queryable,
  cleanupId: string,
  userId: string,
): Promise<AcceptTeamInviteByIdOutcome> {
  const held = await heldRoleInTx(tag, cleanupId, userId)
  return held === null ? { kind: "not_open" } : { kind: "accepted", cleanupId, role: held }
}

async function isBannedInTx(tx: Queryable, cleanupId: string, userId: string): Promise<boolean> {
  const rows = await tx<{ one: number }[]>`
    SELECT 1 AS one FROM cleanup_bans
    WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
    LIMIT 1
  `
  return rows.length > 0
}

async function heldRoleInTx(
  tx: Queryable,
  cleanupId: string,
  userId: string,
): Promise<CleanupMemberRole | null> {
  const rows = await tx<{ role: CleanupMemberRole }[]>`
    SELECT role FROM cleanup_members
    WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
    LIMIT 1
  `
  return rows[0]?.role ?? null
}

async function seatTeamMemberInTx(
  tx: Queryable,
  args: { cleanupId: string; userId: string; role: EventTeamRole; now: Date },
): Promise<CleanupMemberRole> {
  await tx`
    INSERT INTO cleanup_members (cleanup_id, user_id, role, joined_at)
    VALUES (${args.cleanupId}, ${args.userId}, ${args.role}, ${args.now})
    ON CONFLICT (cleanup_id, user_id)
    DO UPDATE SET role = CASE
      WHEN (CASE cleanup_members.role
              WHEN 'organizer' THEN 5 WHEN 'cohost' THEN 4 WHEN 'coordinator' THEN 3
              WHEN 'staff' THEN 2 ELSE 1 END)
         >= (CASE EXCLUDED.role
              WHEN 'organizer' THEN 5 WHEN 'cohost' THEN 4 WHEN 'coordinator' THEN 3
              WHEN 'staff' THEN 2 ELSE 1 END)
      THEN cleanup_members.role
      ELSE EXCLUDED.role
    END
    WHERE cleanup_members.role <> 'organizer'
  `
  return (await heldRoleInTx(tx, args.cleanupId, args.userId)) ?? args.role
}

async function closeAcceptedInviteInTx(
  tx: Queryable,
  args: {
    inviteId: string
    cleanupId: string
    userId: string
    role: EventTeamRole
    now: Date
    from: CleanupMemberRole | null
  },
): Promise<void> {
  await tx`
    UPDATE cleanup_team_invites
    SET status = 'accepted',
        accepted_at = ${args.now},
        accepted_by = ${args.userId},
        invited_email = NULL,
        email_scrubbed_at = now()
    WHERE id = ${args.inviteId}
  `
  await writeHostAudit(tx, {
    actorId: args.userId,
    action: "event.team_role_changed",
    target: `cleanup:${args.cleanupId}`,
    meta: {
      inviteId: args.inviteId,
      targetUserId: args.userId,
      from: args.from,
      to: args.role,
    },
  })
}

export function makeDrizzleHostTeamRepository(sql: Sql): HostTeamRepository {
  return {
    async listTeam(cleanupId: string, limit: number): Promise<EventTeamMemberRecord[]> {
      const rows = await sql<
        {
          id: string
          display_name: string
          handle: string | null
          bio: string | null
          avatar_url: string | null
          role: CleanupMemberRole
          joined_at: Date | null
        }[]
      >`
        SELECT u.id, u.display_name, u.handle, u.bio, u.avatar_url, m.role, m.joined_at
        FROM cleanup_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.cleanup_id = ${cleanupId} AND m.role <> 'member'
        ORDER BY
          CASE m.role
            WHEN 'organizer' THEN 0 WHEN 'cohost' THEN 1 WHEN 'coordinator' THEN 2 ELSE 3
          END,
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
          avatarUrl: r.avatar_url,
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

    findOpenInvite(query: OpenTeamInviteQuery): Promise<EventTeamInviteRecord | null> {
      return readOpenInvite(sql, query)
    },

    async resolveUserByHandle(
      handle: string,
    ): Promise<{ userId: string; email: string | null } | null> {
      // A handle invite mails its accept link, so only an address the account proved it owns may
      // receive it; the in-app notice still reaches the account either way.
      const rows = await sql<{ id: string; email: string | null }[]>`
        SELECT id, CASE WHEN email_verified THEN email END AS email FROM users
        WHERE handle = ${handle} AND deleted_at IS NULL
        LIMIT 1
      `
      const row = rows[0]
      return row === undefined ? null : { userId: row.id, email: row.email }
    },

    async createInviteTx(args: CreateTeamInviteArgs): Promise<CreateTeamInviteOutcome> {
      try {
        return await sql.begin(async (tx) => {
          if ((await eventOpenInTx(tx, args.cleanupId)) !== "open") return { kind: "closed" }
          if (args.invitedUserId !== null) {
            const member = await heldRoleInTx(tx, args.cleanupId, args.invitedUserId)
            if (member !== null && member !== "member") {
              return { kind: "already_member", role: member }
            }
            if (await isBannedInTx(tx, args.cleanupId, args.invitedUserId)) {
              return { kind: "banned" }
            }
          }
          const open = await reofferOpenInvite(tx, args)
          if (open !== null) return open
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
          if (row === undefined) throw AppError.internal()
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
          const open = await sql.begin((tx) => reofferOpenInvite(tx, args))
          if (open === null) throw err
          return open
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
        const openness = await eventOpenInTx(tx, args.cleanupId)
        if (openness === "gone") return { kind: "invalid" }
        if (openness === "closed") return { kind: "closed" }
        const rows = await tx<
          {
            id: string
            role: EventTeamRole
            status: EventTeamInviteStatus
            invited_user_id: string | null
            invited_email: string | null
            invited_by: string | null
            expires_at: Date
          }[]
        >`
          SELECT id, role, status, invited_user_id, invited_email, invited_by, expires_at
          FROM cleanup_team_invites
          WHERE token_hash = ${args.tokenHash} AND cleanup_id = ${args.cleanupId}
          LIMIT 1
          FOR UPDATE
        `
        const invite = rows[0]
        if (invite === undefined || invite.status !== "pending") return { kind: "invalid" }
        if (invite.invited_by === args.userId) return { kind: "wrong_recipient" }
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
        if (await isBannedInTx(tx, args.cleanupId, args.userId)) return { kind: "banned" }
        const held = await heldRoleInTx(tx, args.cleanupId, args.userId)
        const role = await seatTeamMemberInTx(tx, {
          cleanupId: args.cleanupId,
          userId: args.userId,
          role: invite.role,
          now: args.now,
        })
        await closeAcceptedInviteInTx(tx, {
          inviteId: invite.id,
          cleanupId: args.cleanupId,
          userId: args.userId,
          role: invite.role,
          now: args.now,
          from: held,
        })
        return { kind: "accepted", role }
      })
    },

    async listInvitesForUser(
      args: ListInvitesForUserArgs,
    ): Promise<{ items: PendingInviteForUserRecord[]; nextCursor: string | null }> {
      const cursor = parseTimeCursor(args.cursor)
      const cursorFilter =
        cursor !== null ? sql`AND (i.created_at, i.id) < (${cursor.at}, ${cursor.id}::uuid)` : sql``
      const rows = await sql<PendingInviteForUserRowSelect[]>`
        SELECT
          i.id,
          i.role,
          i.created_at,
          i.expires_at,
          c.id AS event_id,
          c.title,
          c.scheduled_at,
          c.ends_at,
          ${cleanupStatusExpr(sql)} AS event_status,
          c.visibility,
          c.address,
          ${publicServedKeyExpr(sql, "ma")} AS cover_key,
          bu.id AS inviter_id,
          bu.display_name AS inviter_name,
          bu.handle AS inviter_handle,
          bu.avatar_url AS inviter_avatar_url
        FROM cleanup_team_invites i
        JOIN cleanups c ON c.id = i.cleanup_id
        LEFT JOIN media_assets ma ON ma.id = c.cover_media_id
        LEFT JOIN users bu ON bu.id = i.invited_by
        WHERE i.invited_user_id = ${args.userId}
          AND i.status = 'pending'
          AND i.expires_at > ${args.now}
          AND c.status <> 'cancelled' AND c.ends_at > ${args.now}
          ${cursorFilter}
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT ${args.limit + 1}
      `
      return pageWith(rows.map(toPendingInviteForUser), args.limit, (last) =>
        encodeTimeCursor({ at: last.createdAt, id: last.id }),
      )
    },

    async acceptInviteByIdTx(args: {
      inviteId: string
      userId: string
      now: Date
    }): Promise<AcceptTeamInviteByIdOutcome> {
      const owned = await sql<{ cleanup_id: string; status: EventTeamInviteStatus }[]>`
        SELECT cleanup_id, status FROM cleanup_team_invites
        WHERE id = ${args.inviteId} AND invited_user_id = ${args.userId}
        LIMIT 1
      `
      const row = owned[0]
      if (row === undefined) return { kind: "not_found" }
      const cleanupId = row.cleanup_id
      if (row.status === "accepted") return alreadySeatedOutcome(sql, cleanupId, args.userId)
      if (row.status !== "pending") return { kind: "not_open" }
      return sql.begin(async (tx): Promise<AcceptTeamInviteByIdOutcome> => {
        const openness = await eventOpenInTx(tx, cleanupId)
        if (openness === "gone") return { kind: "not_found" }
        if (openness === "closed") return { kind: "closed" }
        const rows = await tx<
          { id: string; role: EventTeamRole; status: EventTeamInviteStatus; expires_at: Date }[]
        >`
          SELECT id, role, status, expires_at FROM cleanup_team_invites
          WHERE id = ${args.inviteId} AND cleanup_id = ${cleanupId}
            AND invited_user_id = ${args.userId}
          LIMIT 1
          FOR UPDATE
        `
        const invite = rows[0]
        if (invite === undefined) return { kind: "not_found" }
        if (invite.status === "accepted") return alreadySeatedOutcome(tx, cleanupId, args.userId)
        if (invite.status !== "pending") return { kind: "not_open" }
        if (invite.expires_at.getTime() <= args.now.getTime()) {
          await tx`
            UPDATE cleanup_team_invites
            SET status = 'expired', invited_email = NULL, email_scrubbed_at = now()
            WHERE id = ${invite.id}
          `
          return { kind: "expired" }
        }
        if (await isBannedInTx(tx, cleanupId, args.userId)) return { kind: "banned" }
        const held = await heldRoleInTx(tx, cleanupId, args.userId)
        const role = await seatTeamMemberInTx(tx, {
          cleanupId,
          userId: args.userId,
          role: invite.role,
          now: args.now,
        })
        await closeAcceptedInviteInTx(tx, {
          inviteId: invite.id,
          cleanupId,
          userId: args.userId,
          role: invite.role,
          now: args.now,
          from: held,
        })
        return { kind: "accepted", cleanupId, role }
      })
    },

    async declineInviteTx(args: {
      inviteId: string
      userId: string
      now: Date
    }): Promise<DeclineTeamInviteOutcome> {
      return sql.begin(async (tx): Promise<DeclineTeamInviteOutcome> => {
        const rows = await tx<{ id: string; cleanup_id: string; status: EventTeamInviteStatus }[]>`
          SELECT id, cleanup_id, status FROM cleanup_team_invites
          WHERE id = ${args.inviteId} AND invited_user_id = ${args.userId}
          LIMIT 1
          FOR UPDATE
        `
        const invite = rows[0]
        if (invite === undefined) return "not_found"
        if (invite.status !== "pending") return "not_pending"
        await tx`
          UPDATE cleanup_team_invites
          SET status = 'declined', invited_email = NULL, email_scrubbed_at = now()
          WHERE id = ${invite.id}
        `
        await writeHostAudit(tx, {
          actorId: args.userId,
          action: "event.team_invite_declined",
          target: `cleanup:${invite.cleanup_id}`,
          meta: { inviteId: invite.id },
        })
        return "declined"
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
          WHERE status = 'pending' AND expires_at <= ${now}
          ORDER BY expires_at ASC
          LIMIT ${limit}
        )
        RETURNING id
      `
      return rows.length
    },
  }
}
