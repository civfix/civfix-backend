import { AppError, ErrorCode } from "@civfix/shared"
import type { Sql } from "../db/client.js"
import type { Mailer } from "@civfix/shared/interfaces"
import type { UserStore } from "../auth/stores.js"
import { heading, paragraph } from "../adapters/email-blocks.js"
import { renderEmailBody } from "../adapters/email-layout.js"
import { mailFailure } from "../adapters/mail-failure.js"
import { writeAudit } from "./admin/audit.js"

export interface DataExportServiceDeps {
  sql: Sql
  mailer: Mailer
  users?: UserStore
  fromNoReply: string
  supportEmail: string
}

/**
 * Why a built export never reached the user: the provider refused its size, refused the address, or
 * refused the message itself (or kept refusing it until the retries ran out).
 */
export type DataExportUndeliverable = "oversize" | "permanent" | "rejected"

export type DataExportResult = {
  ok: true
  email: string | null
  undeliverable?: DataExportUndeliverable
}

export interface DataExportService {
  exportData(userId: string): Promise<DataExportResult>
  recordUndeliverable(userId: string, kind: DataExportUndeliverable): Promise<void>
}

export const DATA_EXPORT_MAX_ROWS = 50_000

export const DATA_EXPORT_FREE_TEXT_MAX_ROWS = 5_000

export const DATA_EXPORT_BYTE_BUDGET = 8_000_000

const DATA_EXPORT_FORMAT = "civfix-data-export@1"

const DATA_EXPORT_FILENAME = "civfix-export.json"

const DATA_EXPORT_CONTENT_TYPE = "application/json"

const REDACTED_TOKEN = "[REDACTED]"

const DATA_EXPORT_SUBJECT = "Your civfix data export"

const SMTP_PERMANENT_MIN = 500

export function buildDataExportEmail(
  supportEmail: string,
  truncatedSections: readonly string[],
): { subject: string; text: string; html: string } {
  const subject = DATA_EXPORT_SUBJECT
  const blocks = [
    heading(DATA_EXPORT_SUBJECT),
    paragraph(`Attached is a copy of your civfix data as a JSON file (${DATA_EXPORT_FILENAME}).`),
    paragraph(
      "It includes your profile, reports, posts, comments, messages, events, registrations, " +
        "organizations, volunteer hours, connections, and your issued service-hours transcripts.",
    ),
    paragraph(
      "Secrets (login codes, session tokens, raw device tokens, ticket tokens) and other " +
        "people's material (host-private notes, another organization's verification evidence) " +
        "are intentionally excluded.",
      { muted: true },
    ),
  ]
  if (truncatedSections.length > 0) {
    blocks.push(
      paragraph(
        `Note: some sections (${truncatedSections.join(", ")}) were very large and this export ` +
          `contains only part of them. Email ${supportEmail} to request a complete copy of those sections.`,
      ),
    )
  }
  blocks.push(paragraph("If you did not request this, you can ignore this email.", { muted: true }))
  const { text, html } = renderEmailBody({ preheader: subject, blocks })
  return { subject, text, html }
}

function buildDataExportUndeliverableEmail(supportEmail: string): {
  subject: string
  text: string
  html: string
} {
  const subject = DATA_EXPORT_SUBJECT
  const blocks = [
    heading(DATA_EXPORT_SUBJECT),
    paragraph(
      "Your data export was too large to send by email. Your request is on record, and our team " +
        `will send you a complete copy. You can also email ${supportEmail} about it.`,
    ),
    paragraph("If you did not request this, you can ignore this email.", { muted: true }),
  ]
  const { text, html } = renderEmailBody({ preheader: subject, blocks })
  return { subject, text, html }
}

/**
 * The export body in JSON key order, which is also the order its queries run in. Truncation is reported
 * in this order even though the byte budget is spent in DATA_EXPORT_FIT_ORDER.
 */
const DATA_EXPORT_BODY_ORDER = [
  "reports",
  "posts",
  "comments",
  "chatMessages",
  "dmMessages",
  "volunteerHours",
  "cleanupsOrganized",
  "cleanupsJoined",
  "following",
  "followers",
  "blocks",
  "notificationPrefs",
  "pushTokens",
  "certificates",
  "organizations",
  "eventTeamMemberships",
  "eventConsents",
  "eventRegistrations",
  "eventAnswers",
  "eventCheckins",
] as const

type BodyKey = (typeof DATA_EXPORT_BODY_ORDER)[number]

type SingleRecordKey = "notificationPrefs"

type SectionName = Exclude<BodyKey, SingleRecordKey>

/**
 * The budget is spent on the small structured sections first, so one heavy free-text history (thousands of
 * chat messages) cannot crowd out a user's certificates, consents or registrations.
 */
const DATA_EXPORT_FIT_ORDER = [
  "pushTokens",
  "certificates",
  "organizations",
  "eventConsents",
  "eventRegistrations",
  "eventCheckins",
  "eventTeamMemberships",
  "volunteerHours",
  "cleanupsOrganized",
  "cleanupsJoined",
  "following",
  "followers",
  "blocks",
  "reports",
  "comments",
  "eventAnswers",
  "posts",
  "chatMessages",
  "dmMessages",
] as const satisfies readonly SectionName[]

type UnfittedSection = Exclude<SectionName, (typeof DATA_EXPORT_FIT_ORDER)[number]>

// A section missing from the fit order would silently drop out of every export.
const _everySectionIsFitted: UnfittedSection extends never ? true : never = true

interface SectionPart {
  kind: "section"
  rowCap: number
  /** Fetches one row past `rowCap` so a clipped section is detectable. */
  load(sql: Sql, userId: string, rowCap: number): PromiseLike<readonly object[]>
  /** Runs before the byte budget is charged, so the budget measures the shape that ships. */
  redact?(row: object): object
  /** Runs on the kept rows only; the budget was charged on the loaded shape. */
  present?(row: object): unknown
}

interface SingleRecordPart {
  kind: "record"
  load(sql: Sql, userId: string): PromiseLike<readonly object[]>
}

type BodyParts = { readonly [K in SectionName]: SectionPart } & {
  readonly [K in SingleRecordKey]: SingleRecordPart
}

interface ProfileRow {
  id: string
  display_name: string
  handle: string | null
  email: string | null
  email_verified: boolean
  bio: string | null
  avatar_url: string | null
  donation_url: string | null
  created_at: Date
  deleted_at: Date | null
}

interface PushTokenRow {
  id: string
  platform: string
  created_at: Date
  revoked_at: Date | null
}

async function loadProfile(sql: Sql, userId: string): Promise<ProfileRow | null> {
  const rows = await sql<ProfileRow[]>`
    SELECT id, display_name, handle, email, email_verified, bio, avatar_url, donation_url,
           created_at, deleted_at
    FROM users WHERE id = ${userId} LIMIT 1
  `
  return rows[0] ?? null
}

const DATA_EXPORT_BODY: BodyParts = {
  reports: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (sql, userId, rowCap) => sql<
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
      LIMIT ${rowCap + 1}
    `,
  },

  posts: {
    kind: "section",
    rowCap: DATA_EXPORT_FREE_TEXT_MAX_ROWS,
    load: (sql, userId, rowCap) => sql<
      {
        id: string
        kind: string
        body: string | null
        visibility: string
        reply_to_id: string | null
        repost_of_id: string | null
        created_at: Date
        updated_at: Date
        deleted_at: Date | null
      }[]
    >`
      SELECT id, kind, body, visibility, reply_to_id, repost_of_id, created_at, updated_at, deleted_at
      FROM posts
      WHERE author_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${rowCap + 1}
    `,
  },

  comments: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: () =>
      Promise.resolve<
        { id: string; report_id: string; body: string; created_at: Date; deleted_at: Date | null }[]
      >([]),
  },

  chatMessages: {
    kind: "section",
    rowCap: DATA_EXPORT_FREE_TEXT_MAX_ROWS,
    load: (sql, userId, rowCap) => sql<
      {
        id: string
        cleanup_id: string | null
        report_id: string | null
        group_id: string | null
        body: string | null
        created_at: Date
        deleted_at: Date | null
      }[]
    >`
      SELECT id, cleanup_id, report_id, group_id, body, created_at, deleted_at
      FROM chat_messages
      WHERE sender_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${rowCap + 1}
    `,
  },

  dmMessages: {
    kind: "section",
    rowCap: DATA_EXPORT_FREE_TEXT_MAX_ROWS,
    load: (sql, userId, rowCap) => sql<
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
      LIMIT ${rowCap + 1}
    `,
  },

  volunteerHours: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (sql, userId, rowCap) => sql<
      {
        id: string
        source: string
        report_id: string | null
        cleanup_id: string | null
        jurisdiction_geoid: string | null
        hours: number
        logged_by_user_id: string | null
        created_at: Date
      }[]
    >`
      SELECT id, source, report_id, cleanup_id, jurisdiction_geoid,
        hours::float8 AS hours, logged_by_user_id, created_at
      FROM volunteer_hours
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${rowCap + 1}
    `,
  },

  cleanupsOrganized: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (sql, userId, rowCap) => sql<{ id: string; title: string | null; created_at: Date }[]>`
      SELECT id, title, created_at FROM cleanups
      WHERE organizer_user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${rowCap + 1}
    `,
  },

  cleanupsJoined: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (sql, userId, rowCap) => sql<{ cleanup_id: string; role: string; joined_at: Date }[]>`
      SELECT cleanup_id, role, joined_at FROM cleanup_members
      WHERE user_id = ${userId}
      ORDER BY joined_at DESC
      LIMIT ${rowCap + 1}
    `,
  },

  following: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (sql, userId, rowCap) => sql<{ followee_id: string }[]>`
      SELECT followee_id FROM follows_people WHERE follower_id = ${userId}
      LIMIT ${rowCap + 1}
    `,
    present: (row: { followee_id: string }) => row.followee_id,
  },

  followers: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (sql, userId, rowCap) => sql<{ follower_id: string }[]>`
      SELECT follower_id FROM follows_people WHERE followee_id = ${userId}
      LIMIT ${rowCap + 1}
    `,
    present: (row: { follower_id: string }) => row.follower_id,
  },

  blocks: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (sql, userId, rowCap) => sql<{ blocked_id: string }[]>`
      SELECT blocked_id FROM user_blocks WHERE blocker_id = ${userId}
      LIMIT ${rowCap + 1}
    `,
    present: (row: { blocked_id: string }) => row.blocked_id,
  },

  notificationPrefs: {
    kind: "record",
    load: (sql, userId) => sql<
      {
        user_id: string
        push: boolean
        cleanup_chat: boolean
        report_updates: boolean
        follows: boolean
        quiet_start: string | null
        quiet_end: string | null
        mentions: boolean
        host_broadcasts: boolean
      }[]
    >`
      SELECT user_id, push, cleanup_chat, report_updates, follows, quiet_start, quiet_end, mentions,
        host_broadcasts
      FROM notification_prefs WHERE user_id = ${userId} LIMIT 1
    `,
  },

  pushTokens: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (sql, userId, rowCap) => sql<PushTokenRow[]>`
      SELECT id, platform, created_at, revoked_at FROM push_tokens WHERE user_id = ${userId}
      LIMIT ${rowCap + 1}
    `,
    redact: (t: PushTokenRow) => ({
      id: t.id,
      platform: t.platform,
      token: REDACTED_TOKEN,
      createdAt: t.created_at,
      revokedAt: t.revoked_at,
    }),
  },

  certificates: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (sql, userId, rowCap) => sql<
      {
        code: string
        locale: string
        holder_name: string
        holder_handle: string | null
        total_hours: number
        entry_count: number
        period_start: Date | null
        period_end: Date | null
        document_sha256: string
        byte_size: number
        issued_at: Date
        revoked_at: Date | null
        revoked_reason: string | null
      }[]
    >`
      SELECT
        code, locale, holder_name, holder_handle, total_hours::float8 AS total_hours, entry_count,
        period_start, period_end, document_sha256, byte_size, issued_at, revoked_at, revoked_reason
      FROM service_hours_certificates
      WHERE user_id = ${userId}
      ORDER BY issued_at DESC
      LIMIT ${rowCap + 1}
    `,
  },

  organizations: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (sql, userId, rowCap) => sql<
      { organization_id: string; slug: string; name: string; role: string; joined_at: Date }[]
    >`
      SELECT om.organization_id, o.slug, o.name, om.role, om.joined_at
      FROM organization_members om
      JOIN organizations o ON o.id = om.organization_id
      WHERE om.user_id = ${userId}
      ORDER BY om.joined_at DESC
      LIMIT ${rowCap + 1}
    `,
  },

  eventTeamMemberships: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (sql, userId, rowCap) => sql<
      { cleanup_id: string; role: string; joined_at: Date | null }[]
    >`
      SELECT cleanup_id, role, joined_at FROM cleanup_members
      WHERE user_id = ${userId} AND role <> 'member'
      ORDER BY joined_at DESC NULLS LAST
      LIMIT ${rowCap + 1}
    `,
  },

  eventConsents: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (sql, userId, rowCap) => sql<
      {
        cleanup_id: string
        terms_version: string
        disclosure_version: string
        host_contact_opt_in: boolean
        sms_opt_in: boolean
        accepted_at: Date
      }[]
    >`
      SELECT cleanup_id, terms_version, disclosure_version, host_contact_opt_in, sms_opt_in,
        accepted_at
      FROM event_consents WHERE user_id = ${userId}
      ORDER BY accepted_at DESC
      LIMIT ${rowCap + 1}
    `,
  },

  eventRegistrations: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (sql, userId, rowCap) => sql<
      {
        id: string
        cleanup_id: string
        ticket_type_name: string | null
        party_size: number
        status: string
        source: string
        registered_at: Date
        cancelled_at: Date | null
      }[]
    >`
      SELECT r.id, r.cleanup_id, t.name AS ticket_type_name, r.party_size, r.status, r.source,
             r.registered_at, r.cancelled_at
      FROM cleanup_registrations r
      LEFT JOIN cleanup_ticket_types t ON t.id = r.ticket_type_id
      WHERE r.user_id = ${userId}
      ORDER BY r.registered_at DESC
      LIMIT ${rowCap + 1}
    `,
  },

  eventAnswers: {
    kind: "section",
    rowCap: DATA_EXPORT_FREE_TEXT_MAX_ROWS,
    load: (sql, userId, rowCap) => sql<
      { cleanup_id: string; prompt: string; value: string | null }[]
    >`
      SELECT a.cleanup_id, q.prompt,
             COALESCE(a.value_text, a.value_json::text) AS value
      FROM cleanup_answers a
      JOIN cleanup_questions q ON q.id = a.question_id
      JOIN cleanup_registrations r ON r.id = a.registration_id
      WHERE r.user_id = ${userId} AND a.scrubbed_at IS NULL
      ORDER BY a.created_at DESC
      LIMIT ${rowCap + 1}
    `,
  },

  eventCheckins: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (sql, userId, rowCap) => sql<
      {
        cleanup_id: string
        seat_index: number
        checked_in_at: Date
        checkin_method: string | null
      }[]
    >`
      SELECT s.cleanup_id, s.seat_index, s.checked_in_at, s.checkin_method
      FROM cleanup_registration_seats s
      JOIN cleanup_registrations r ON r.id = s.registration_id
      WHERE r.user_id = ${userId} AND s.checked_in_at IS NOT NULL
      ORDER BY s.checked_in_at DESC
      LIMIT ${rowCap + 1}
    `,
  },
}

function loadBodyPart(sql: Sql, userId: string, key: BodyKey): PromiseLike<readonly object[]> {
  const part = DATA_EXPORT_BODY[key]
  return part.kind === "section" ? part.load(sql, userId, part.rowCap) : part.load(sql, userId)
}

/** Queries run in body order: the statements go out in the same sequence on every export. */
async function loadBody(sql: Sql, userId: string): Promise<Map<BodyKey, readonly object[]>> {
  const loaded = await Promise.all(
    DATA_EXPORT_BODY_ORDER.map((key) => loadBodyPart(sql, userId, key)),
  )
  return new Map(DATA_EXPORT_BODY_ORDER.map((key, i) => [key, loaded[i] ?? []]))
}

interface FittedBody {
  body: Record<BodyKey, unknown>
  truncatedSections: SectionName[]
  sectionCaps: Record<string, number | undefined>
}

function fitBody(loaded: ReadonlyMap<BodyKey, readonly object[]>): FittedBody {
  const truncatedCaps = new Map<SectionName, number>()
  let usedBytes = 0

  const fit = (name: SectionName, rows: readonly object[], rowCap: number): object[] => {
    let truncated = rows.length > rowCap
    const kept: object[] = []
    for (const row of truncated ? rows.slice(0, rowCap) : rows) {
      const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1
      if (usedBytes + size > DATA_EXPORT_BYTE_BUDGET) {
        truncated = true
        break
      }
      usedBytes += size
      kept.push(row)
    }
    if (truncated) truncatedCaps.set(name, rowCap)
    return kept
  }

  const sections = new Map<SectionName, unknown[]>()
  for (const name of DATA_EXPORT_FIT_ORDER) {
    const { rowCap, redact, present } = DATA_EXPORT_BODY[name]
    const rows = loaded.get(name) ?? []
    const kept = fit(name, redact ? rows.map(redact) : rows, rowCap)
    sections.set(name, present ? kept.map(present) : kept)
  }

  const body = Object.fromEntries(
    DATA_EXPORT_BODY_ORDER.map((key) => [
      key,
      key === "notificationPrefs" ? (loaded.get(key)?.[0] ?? null) : sections.get(key),
    ]),
  ) as Record<BodyKey, unknown>

  const truncatedSections = DATA_EXPORT_BODY_ORDER.filter(
    (key): key is SectionName => key !== "notificationPrefs" && truncatedCaps.has(key),
  )
  const sectionCaps = Object.fromEntries(
    truncatedSections.map((name) => [name, truncatedCaps.get(name)]),
  )
  return { body, truncatedSections, sectionCaps }
}

export function makeDataExportService(deps: DataExportServiceDeps): DataExportService {
  const { sql, mailer, users, fromNoReply, supportEmail } = deps

  /**
   * The operator-visible trail for an export that has to be fulfilled by hand. Written before any notice
   * so the request is on record even if the notice fails. Carries no address or export content.
   */
  async function recordUndeliverable(userId: string, kind: DataExportUndeliverable): Promise<void> {
    await writeAudit(sql, {
      actorId: null,
      action: "data_export.undeliverable",
      target: `user:${userId}`,
      meta: { reason: kind },
    })
  }

  async function sendUndeliverableNotice(to: string): Promise<void> {
    const notice = buildDataExportUndeliverableEmail(supportEmail)
    try {
      await mailer.sendOutbound({ from: fromNoReply, to, ...notice })
    } catch (err) {
      // The request is already on record for an operator, so a failed notice completes the job rather
      // than retrying, which would rebuild the export and hit the same size refusal again.
      throw new AppError(ErrorCode.CONFLICT, "The data export notice could not be sent", {
        cause: err,
      })
    }
  }

  async function resolveEmail(userId: string, profile: ProfileRow | null): Promise<string | null> {
    if (profile?.email != null) return profile.email
    if (!users) return null
    return (await users.findById(userId))?.email ?? null
  }

  async function deliver(
    userId: string,
    email: string,
    exportObject: object,
    truncatedSections: readonly string[],
  ): Promise<DataExportResult> {
    const bytes = new TextEncoder().encode(JSON.stringify(exportObject))
    const rendered = buildDataExportEmail(supportEmail, truncatedSections)
    try {
      await mailer.sendOutbound({
        from: fromNoReply,
        to: email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        attachments: [
          { filename: DATA_EXPORT_FILENAME, contentType: DATA_EXPORT_CONTENT_TYPE, content: bytes },
        ],
      })
    } catch (err) {
      const kind = undeliverableKind(err)
      if (kind === null) throw err
      await recordUndeliverable(userId, kind)
      // A rejected recipient would bounce a notice too; only a size refusal can still reach the user.
      if (kind === "oversize") await sendUndeliverableNotice(email)
      return { ok: true, email, undeliverable: kind }
    }
    return { ok: true, email }
  }

  return {
    async exportData(userId: string): Promise<DataExportResult> {
      const profile = await loadProfile(sql, userId)
      const loaded = await loadBody(sql, userId)
      const email = await resolveEmail(userId, profile)
      const { body, truncatedSections, sectionCaps } = fitBody(loaded)

      const exportObject = {
        exportedAt: new Date().toISOString(),
        format: DATA_EXPORT_FORMAT,
        userId,
        profile,
        ...body,
        truncated:
          truncatedSections.length > 0
            ? {
                sections: truncatedSections,
                capPerSection: DATA_EXPORT_MAX_ROWS,
                sectionCaps,
                byteBudget: DATA_EXPORT_BYTE_BUDGET,
                note: `These sections were clipped because this export reached its per-section or overall size limit. Email ${supportEmail} to request a complete copy of the truncated sections.`,
              }
            : null,
      }

      if (email === null) return { ok: true, email: null }
      return deliver(userId, email, exportObject, truncatedSections)
    },

    recordUndeliverable,
  }
}

// A 5xx the provider sends in answer to the message body refuses this message, not our credentials or
// sender, so rebuilding and resending the same export can only be refused again.
function isMessageRejection(failure: ReturnType<typeof mailFailure>): boolean {
  return (
    failure.code === "EMESSAGE" &&
    failure.command === "DATA" &&
    failure.responseCode !== undefined &&
    failure.responseCode >= SMTP_PERMANENT_MIN
  )
}

function undeliverableKind(err: unknown): DataExportUndeliverable | null {
  const failure = mailFailure(err)
  if (failure.kind === "oversize" || failure.kind === "permanent") return failure.kind
  if (isMessageRejection(failure)) return "rejected"
  return null
}
