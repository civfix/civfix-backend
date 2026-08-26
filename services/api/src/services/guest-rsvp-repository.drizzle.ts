import type { CleanupStatus, GuestContactChannel } from "@civfix/shared"
import type { Sql } from "../db/client.js"
import { encodeTimeCursor, pageWith, type TimeCursor } from "../db/cursor-helpers.js"
import type {
  GuestEventView,
  GuestOtpRecord,
  GuestRecipient,
  GuestRosterRow,
  GuestRsvpRepository,
  InsertGuestOtpArgs,
  UpsertGuestArgs,
} from "./guest-rsvp-service.js"

interface GuestRowSelect {
  id: string
  name: string
  channel: GuestContactChannel
  email: string | null
  phone: string | null
  verified_at: Date
  cancelled_at: Date | null
  created_at: Date
}

function toRosterRow(r: GuestRowSelect): GuestRosterRow {
  return {
    id: r.id,
    name: r.name,
    channel: r.channel,
    email: r.email,
    phone: r.phone,
    verifiedAt: r.verified_at,
    cancelledAt: r.cancelled_at,
  }
}

export function makeDrizzleGuestRsvpRepository(sql: Sql): GuestRsvpRepository {
  return {
    async findEvent(cleanupId: string): Promise<GuestEventView | null> {
      const rows = await sql<
        {
          id: string
          title: string
          status: CleanupStatus
          scheduled_at: Date
          address: string | null
          lng: number
          lat: number
        }[]
      >`
        SELECT
          c.id,
          c.title,
          c.status,
          c.scheduled_at,
          c.address,
          ST_X(c.geom) AS lng,
          ST_Y(c.geom) AS lat
        FROM cleanups c
        WHERE c.id = ${cleanupId}
        LIMIT 1
      `
      const row = rows[0]
      if (row === undefined) return null
      return {
        id: row.id,
        title: row.title,
        status: row.status,
        scheduledAt: row.scheduled_at,
        address: row.address,
        lat: row.lat,
        lng: row.lng,
      }
    },

    async countActiveGuests(cleanupId: string): Promise<number> {
      const rows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM cleanup_guests
        WHERE cleanup_id = ${cleanupId} AND cancelled_at IS NULL
      `
      return rows[0]?.n ?? 0
    },

    async goingCount(cleanupId: string): Promise<number> {
      const rows = await sql<{ n: number }[]>`
        SELECT
          (SELECT count(*)::int FROM cleanup_members m WHERE m.cleanup_id = ${cleanupId})
          + (
            SELECT count(*)::int FROM cleanup_guests g
            WHERE g.cleanup_id = ${cleanupId} AND g.cancelled_at IS NULL
          ) AS n
      `
      return rows[0]?.n ?? 0
    },

    async isPhoneOptedOut(phone: string): Promise<boolean> {
      const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM sms_opt_outs WHERE phone = ${phone} LIMIT 1
      `
      return rows.length > 0
    },

    async recordPhoneOptOut(phone: string): Promise<void> {
      await sql`
        INSERT INTO sms_opt_outs (phone) VALUES (${phone})
        ON CONFLICT (phone) DO NOTHING
      `
    },

    async invalidateActiveOtps(cleanupId: string, contact: string, now: Date): Promise<void> {
      await sql`
        UPDATE guest_otps SET consumed_at = ${now}
        WHERE cleanup_id = ${cleanupId} AND contact = ${contact} AND consumed_at IS NULL
      `
    },

    async insertOtp(args: InsertGuestOtpArgs): Promise<void> {
      await sql`
        INSERT INTO guest_otps (cleanup_id, channel, contact, name, code_hash, expires_at)
        VALUES (
          ${args.cleanupId}, ${args.channel}, ${args.contact}, ${args.name},
          ${args.codeHash}, ${args.expiresAt}
        )
      `
    },

    async findLatestActiveOtp(
      cleanupId: string,
      contact: string,
      now: Date,
    ): Promise<GuestOtpRecord | null> {
      const rows = await sql<
        {
          id: string
          cleanup_id: string
          channel: GuestContactChannel
          contact: string
          name: string
          code_hash: string
        }[]
      >`
        SELECT id, cleanup_id, channel, contact, name, code_hash
        FROM guest_otps
        WHERE cleanup_id = ${cleanupId}
          AND contact = ${contact}
          AND consumed_at IS NULL
          AND expires_at > ${now}
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `
      const row = rows[0]
      if (row === undefined) return null
      return {
        id: row.id,
        cleanupId: row.cleanup_id,
        channel: row.channel,
        contact: row.contact,
        name: row.name,
        codeHash: row.code_hash,
      }
    },

    async incrementOtpAttempts(otpId: string): Promise<number> {
      const rows = await sql<{ attempts: number }[]>`
        UPDATE guest_otps SET attempts = attempts + 1 WHERE id = ${otpId} RETURNING attempts
      `
      return rows[0]?.attempts ?? 0
    },

    async markOtpConsumed(otpId: string, now: Date): Promise<boolean> {
      const rows = await sql<{ id: string }[]>`
        UPDATE guest_otps SET consumed_at = ${now}
        WHERE id = ${otpId} AND consumed_at IS NULL
        RETURNING id
      `
      return rows.length > 0
    },

    async upsertVerifiedGuest(args: UpsertGuestArgs): Promise<{ id: string }> {
      const rows = await sql<{ id: string }[]>`
        INSERT INTO cleanup_guests (
          cleanup_id, name, channel, email, phone, contact_key, manage_token_hash, verified_at
        ) VALUES (
          ${args.cleanupId}, ${args.name}, ${args.channel}, ${args.email}, ${args.phone},
          ${args.contactKey}, ${args.manageTokenHash}, ${args.now}
        )
        ON CONFLICT (cleanup_id, contact_key) WHERE cancelled_at IS NULL AND contact_key IS NOT NULL
        DO UPDATE SET
          name = EXCLUDED.name,
          channel = EXCLUDED.channel,
          email = EXCLUDED.email,
          phone = EXCLUDED.phone,
          manage_token_hash = EXCLUDED.manage_token_hash,
          verified_at = EXCLUDED.verified_at,
          contact_scrubbed_at = NULL
        RETURNING id
      `
      const row = rows[0]
      if (row === undefined) throw new Error("guest rsvp: upsert returned no row")
      return { id: row.id }
    },

    async findGuestByManageTokenHash(
      hash: string,
    ): Promise<{ id: string; cleanupId: string; cancelledAt: Date | null } | null> {
      const rows = await sql<{ id: string; cleanup_id: string; cancelled_at: Date | null }[]>`
        SELECT id, cleanup_id, cancelled_at
        FROM cleanup_guests
        WHERE manage_token_hash = ${hash}
        LIMIT 1
      `
      const row = rows[0]
      if (row === undefined) return null
      return { id: row.id, cleanupId: row.cleanup_id, cancelledAt: row.cancelled_at }
    },

    async cancelGuest(guestId: string, now: Date): Promise<void> {
      await sql`
        UPDATE cleanup_guests
        SET cancelled_at = ${now},
            email = NULL,
            phone = NULL,
            contact_key = NULL,
            contact_scrubbed_at = COALESCE(contact_scrubbed_at, ${now})
        WHERE id = ${guestId} AND cancelled_at IS NULL
      `
    },

    async listGuests(args: {
      cleanupId: string
      cursor: TimeCursor | null
      limit: number
    }): Promise<{ rows: GuestRosterRow[]; nextCursor: string | null }> {
      const cursorFilter =
        args.cursor !== null
          ? sql`AND (created_at, id) < (${args.cursor.at}, ${args.cursor.id}::uuid)`
          : sql``
      const rows = await sql<GuestRowSelect[]>`
        SELECT id, name, channel, email, phone, verified_at, cancelled_at, created_at
        FROM cleanup_guests
        WHERE cleanup_id = ${args.cleanupId}
          ${cursorFilter}
        ORDER BY created_at DESC, id DESC
        LIMIT ${args.limit + 1}
      `
      const { items, nextCursor } = pageWith(rows, args.limit, (last) =>
        encodeTimeCursor({ at: last.created_at, id: last.id }),
      )
      return { rows: items.map(toRosterRow), nextCursor }
    },

    async listContactableGuests(cleanupId: string, limit: number): Promise<GuestRecipient[]> {
      const rows = await sql<
        {
          id: string
          name: string
          channel: GuestContactChannel
          email: string | null
          phone: string | null
        }[]
      >`
        SELECT g.id, g.name, g.channel, g.email, g.phone
        FROM cleanup_guests g
        WHERE g.cleanup_id = ${cleanupId}
          AND g.cancelled_at IS NULL
          AND g.contact_scrubbed_at IS NULL
          AND (g.email IS NOT NULL OR g.phone IS NOT NULL)
          AND (
            g.phone IS NULL
            OR NOT EXISTS (SELECT 1 FROM sms_opt_outs o WHERE o.phone = g.phone)
          )
        ORDER BY g.created_at ASC, g.id ASC
        LIMIT ${limit}
      `
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        channel: r.channel,
        email: r.email,
        phone: r.phone,
      }))
    },

    async scrubExpiredGuestContacts(args: {
      cutoff: Date
      now: Date
      batchSize: number
    }): Promise<number> {
      const rows = await sql<{ id: string }[]>`
        WITH stale AS (
          SELECT g.id
          FROM cleanup_guests g
          JOIN cleanups c ON c.id = g.cleanup_id
          WHERE g.contact_scrubbed_at IS NULL
            AND (g.email IS NOT NULL OR g.phone IS NOT NULL OR g.contact_key IS NOT NULL)
            AND (
              c.scheduled_at < ${args.cutoff}
              OR (c.status = 'cancelled' AND g.created_at < ${args.cutoff})
            )
          LIMIT ${args.batchSize}
        )
        UPDATE cleanup_guests g
        SET email = NULL, phone = NULL, contact_key = NULL, contact_scrubbed_at = ${args.now}
        FROM stale
        WHERE g.id = stale.id
        RETURNING g.id
      `
      return rows.length
    },

    async deleteStaleOtps(args: { cutoff: Date; batchSize: number }): Promise<number> {
      const rows = await sql<{ id: string }[]>`
        DELETE FROM guest_otps
        WHERE id IN (
          SELECT id FROM guest_otps WHERE created_at < ${args.cutoff} LIMIT ${args.batchSize}
        )
        RETURNING id
      `
      return rows.length
    },
  }
}
