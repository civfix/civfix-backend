import { inArray, sql } from "drizzle-orm"
import { DELETED_USER_LABEL } from "@civfix/shared"
import type { Db } from "../db/client.js"

export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0]

export interface TransferredEvent extends Record<string, unknown> {
  cleanup_id: string
  new_organizer: string
  title: string
}

export interface ErasureRepository {
  transferHostedEvents(tx: DbTransaction, userId: string): Promise<TransferredEvent[]>
  releaseOrganizations(tx: DbTransaction, userId: string): Promise<void>
  scrubAttendeeContributions(tx: DbTransaction, userId: string): Promise<string[]>
  scrubModerationSnapshots(tx: DbTransaction, userId: string): Promise<void>
  purgeVerificationDocuments(tx: DbTransaction, userId: string): Promise<string[]>
}

// Takes no handle: every step runs on the erasure transaction its caller passes in, never on the pool.
export function makeDrizzleErasureRepository(): ErasureRepository {
  return {
    transferHostedEvents,
    releaseOrganizations,
    scrubAttendeeContributions,
    scrubModerationSnapshots,
    purgeVerificationDocuments,
  }
}

async function transferHostedEvents(tx: DbTransaction, id: string): Promise<TransferredEvent[]> {
  const moved = [
    ...(await transferToOrganizationOwners(tx, id)),
    ...(await transferToCohosts(tx, id)),
  ]
  await auditHostTransfers(tx, id, moved)
  await demoteRemainingTeamRoles(tx, id)
  return moved
}

async function transferToOrganizationOwners(
  tx: DbTransaction,
  id: string,
): Promise<TransferredEvent[]> {
  return tx.execute<TransferredEvent>(sql`
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
}

async function transferToCohosts(tx: DbTransaction, id: string): Promise<TransferredEvent[]> {
  return tx.execute<TransferredEvent>(sql`
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
}

async function auditHostTransfers(
  tx: DbTransaction,
  id: string,
  moved: readonly TransferredEvent[],
): Promise<void> {
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
}

async function demoteRemainingTeamRoles(tx: DbTransaction, id: string): Promise<void> {
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
}

async function releaseOrganizations(tx: DbTransaction, id: string): Promise<void> {
  await lockOwnedOrganizations(tx, id)
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

// Every membership mutation locks its organization row first, so taking those same row locks (in id
// order, so two erasures cannot deadlock) before the owner step-down keeps a concurrent member or role
// change from racing the successor pick.
async function lockOwnedOrganizations(tx: DbTransaction, id: string): Promise<void> {
  await tx.execute(sql`
    SELECT o.id FROM organizations o
    WHERE EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.organization_id = o.id AND om.user_id = ${id} AND om.role = 'owner'
    )
    ORDER BY o.id
    FOR UPDATE
  `)
}

async function scrubAttendeeContributions(tx: DbTransaction, id: string): Promise<string[]> {
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

async function scrubModerationSnapshots(tx: DbTransaction, id: string): Promise<void> {
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
}

async function purgeVerificationDocuments(tx: DbTransaction, id: string): Promise<string[]> {
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
  return verificationMedia.flatMap((m) =>
    [m.r2_key, m.served_key, m.thumb_key].filter((k): k is string => k !== null),
  )
}
