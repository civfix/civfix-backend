/**
 * Data-export service (App-Store-audit remediation: "request a copy of my data").
 *
 * A pure `makeDataExportService({ sql, mailer, storage, users, fromNoReply })` factory (no Fastify, no
 * container) so it unit-tests with an InMemoryUserStore + FakeMailer. `exportData(userId)` gathers the
 * user's own data across the domain tables (reusing the join shapes from
 * services/admin/admin-user-repository.drizzle.ts), serializes it to a JSON Uint8Array, and emails it to
 * the account as a single attachment via `mailer.sendOutbound` (the only mailer method that carries
 * attachments + a controllable From). It deliberately EXCLUDES secrets/operator data (otp, session
 * tokens, user_moderation, oauth tokens, raw push tokens).
 *
 * The send is synchronous (the codebase has no email queue, mirroring the OTP path). When the account has
 * no email on file (Apple/OTP-less/anon-claimed) it skips the send and returns { ok: true, email: null }.
 */

import type { Sql } from "../db/client.js"
import type { Mailer, Storage } from "@civfix/shared/interfaces"
import type { UserStore } from "../auth/stores.js"

export interface DataExportServiceDeps {
  sql: Sql
  mailer: Mailer
  /** Object storage (reserved for future media-byte inclusion; not loaded inline today). */
  storage: Storage
  /** The auth bundle's UserStore, to resolve the requester's profile + recipient email. */
  users: UserStore
  /** The no-reply From the export email is sent from (env.MAIL_FROM_NOREPLY). */
  fromNoReply: string
}

export interface DataExportService {
  /**
   * Assemble the user's data export and email it. Returns { ok: true, email } where `email` is the
   * recipient (null when the account has no email and the send was skipped).
   */
  exportData(userId: string): Promise<{ ok: true; email: string | null }>
}

export function makeDataExportService(deps: DataExportServiceDeps): DataExportService {
  const { sql, mailer, users, fromNoReply } = deps

  return {
    async exportData(userId: string): Promise<{ ok: true; email: string | null }> {
      const user = await users.findById(userId)
      // Defensive: a deleted/missing user simply yields a minimal export with no email send.
      const email = user?.email ?? null

      // ----- Gather (per-source SELECTs scoped to this user; secrets excluded) -----
      // profile (the durable users row; PII the user owns)
      const profileRows = await sql<
        {
          id: string
          display_name: string
          handle: string | null
          email: string | null
          email_verified: boolean
          bio: string | null
          avatar_url: string | null
          created_at: Date
          deleted_at: Date | null
        }[]
      >`
        SELECT id, display_name, handle, email, email_verified, bio, avatar_url, created_at, deleted_at
        FROM users WHERE id = ${userId} LIMIT 1
      `

      // reports the user filed (join the jurisdiction for the place label; mirror listUserReports)
      const reports = await sql<
        {
          id: string
          category: string
          title: string | null
          description: string | null
          place: string | null
          status: string
          created_at: Date
        }[]
      >`
        SELECT r.id, r.category, r.title, r.description, j.name AS place, r.status, r.created_at
        FROM reports r
        LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
        WHERE r.reporter_user_id = ${userId}
        ORDER BY r.created_at DESC
      `

      // discussion comments authored on civic reports
      const comments = await sql<
        { id: string; report_id: string; body: string; created_at: Date; deleted_at: Date | null }[]
      >`
        SELECT id, report_id, body, created_at, deleted_at
        FROM report_discussion_messages
        WHERE author_user_id = ${userId}
        ORDER BY created_at DESC
      `

      // cleanup (group) chat messages the user sent (mirror listUserMessages)
      const chatMessages = await sql<
        {
          id: string
          cleanup_id: string
          body: string | null
          created_at: Date
          deleted_at: Date | null
        }[]
      >`
        SELECT id, cleanup_id, body, created_at, deleted_at
        FROM chat_messages
        WHERE sender_id = ${userId}
        ORDER BY created_at DESC
      `

      // direct messages the user sent (the user's OWN messages only; peers' messages are not the user's data)
      const dmMessages = await sql<
        {
          id: string
          thread_id: string
          body: string | null
          created_at: Date
          deleted_at: Date | null
        }[]
      >`
        SELECT id, thread_id, body, created_at, deleted_at
        FROM dm_messages
        WHERE sender_id = ${userId}
        ORDER BY created_at DESC
      `

      // cleanups (events) organized + joined
      const cleanupsOrganized = await sql<
        { id: string; title: string | null; created_at: Date }[]
      >`
        SELECT id, title, created_at FROM cleanups
        WHERE organizer_user_id = ${userId}
        ORDER BY created_at DESC
      `
      const cleanupsJoined = await sql<
        { cleanup_id: string; role: string; joined_at: Date }[]
      >`
        SELECT cleanup_id, role, joined_at FROM cleanup_members
        WHERE user_id = ${userId}
        ORDER BY joined_at DESC
      `

      // social graph (follows people, in both directions) + blocks the user set
      const following = await sql<{ followee_id: string }[]>`
        SELECT followee_id FROM follows_people WHERE follower_id = ${userId}
      `
      const followers = await sql<{ follower_id: string }[]>`
        SELECT follower_id FROM follows_people WHERE followee_id = ${userId}
      `
      const blocks = await sql<{ blocked_id: string }[]>`
        SELECT blocked_id FROM user_blocks WHERE blocker_id = ${userId}
      `

      // notification preferences (no secrets)
      const notificationPrefs = await sql<Record<string, unknown>[]>`
        SELECT * FROM notification_prefs WHERE user_id = ${userId} LIMIT 1
      `

      // push tokens — REDACT the raw token (device registration is the user's data, the secret is not)
      const pushTokenRows = await sql<
        { id: string; platform: string; created_at: Date; revoked_at: Date | null }[]
      >`
        SELECT id, platform, created_at, revoked_at FROM push_tokens WHERE user_id = ${userId}
      `
      const pushTokens = pushTokenRows.map((t) => ({
        id: t.id,
        platform: t.platform,
        token: "[REDACTED]",
        createdAt: t.created_at,
        revokedAt: t.revoked_at,
      }))

      // verification status (the "verified neighbor" state; documents jsonb omitted as sensitive)
      const verification = await sql<{ status: string; created_at: Date }[]>`
        SELECT status, created_at FROM user_verification WHERE user_id = ${userId} LIMIT 1
      `

      const exportObject = {
        exportedAt: new Date().toISOString(),
        format: "civfix-data-export@1",
        userId,
        profile: profileRows[0] ?? null,
        reports,
        comments,
        chatMessages,
        dmMessages,
        cleanupsOrganized,
        cleanupsJoined,
        following: following.map((f) => f.followee_id),
        followers: followers.map((f) => f.follower_id),
        blocks: blocks.map((b) => b.blocked_id),
        notificationPrefs: notificationPrefs[0] ?? null,
        pushTokens,
        verification: verification[0] ?? null,
      }

      const bytes = new TextEncoder().encode(JSON.stringify(exportObject, null, 2))

      // No email on file (Apple / OTP-less / anon-claimed): skip the send, surface email:null so the
      // client can tell the user to add an email first.
      if (email === null) return { ok: true, email: null }

      const text =
        "Attached is a copy of your civfix data (JSON). It includes your profile, reports, comments, " +
        "messages, events, and connections. Secrets (login codes, session tokens, raw device tokens) " +
        "are intentionally excluded.\n\nIf you did not request this, you can ignore this email."

      await mailer.sendOutbound({
        from: fromNoReply,
        to: email,
        subject: "Your civfix data export",
        text,
        attachments: [
          {
            filename: "civfix-export.json",
            contentType: "application/json",
            content: bytes,
          },
        ],
      })

      return { ok: true, email }
    },
  }
}
