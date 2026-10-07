import { AppError, ErrorCode } from "@civfix/shared"
import type { Sql } from "../db/client.js"
import type { Mailer } from "@civfix/shared/interfaces"
import type { UserStore } from "../auth/stores.js"
import { heading, paragraph } from "../adapters/email-blocks.js"
import { renderEmailBody } from "../adapters/email-layout.js"
import { mailFailure } from "../adapters/mail-failure.js"
import { insertAuditRow } from "./admin/audit-repository.drizzle.js"
import { makeDrizzleDataExportRepository } from "./data-export-repository.drizzle.js"
import type {
  BlockExportRow,
  DataExportRepository,
  FollowerExportRow,
  FollowingExportRow,
  ProfileRow,
  PushTokenRow,
} from "./data-export-repository.js"

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

// A section missing from the fit order would silently drop out of every export; a gap makes this
// binding's type `never`, so the assignment stops compiling.
const EXHAUSTIVE_FIT_ORDER: UnfittedSection extends never ? typeof DATA_EXPORT_FIT_ORDER : never =
  DATA_EXPORT_FIT_ORDER

interface SectionPart {
  kind: "section"
  rowCap: number
  load(repo: DataExportRepository, userId: string, rowCap: number): PromiseLike<readonly object[]>
  /** Runs before the byte budget is charged, so the budget measures the shape that ships. */
  redact?(row: object): object
  /** Runs on the kept rows only; the budget was charged on the loaded shape. */
  present?(row: object): unknown
}

interface SingleRecordPart {
  kind: "record"
  load(repo: DataExportRepository, userId: string): PromiseLike<readonly object[]>
}

type BodyParts = { readonly [K in SectionName]: SectionPart } & {
  readonly [K in SingleRecordKey]: SingleRecordPart
}

const DATA_EXPORT_BODY: BodyParts = {
  reports: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (repo, userId, rowCap) => repo.reports(userId, rowCap),
  },

  posts: {
    kind: "section",
    rowCap: DATA_EXPORT_FREE_TEXT_MAX_ROWS,
    load: (repo, userId, rowCap) => repo.posts(userId, rowCap),
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
    load: (repo, userId, rowCap) => repo.chatMessages(userId, rowCap),
  },

  dmMessages: {
    kind: "section",
    rowCap: DATA_EXPORT_FREE_TEXT_MAX_ROWS,
    load: (repo, userId, rowCap) => repo.dmMessages(userId, rowCap),
  },

  volunteerHours: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (repo, userId, rowCap) => repo.volunteerHours(userId, rowCap),
  },

  cleanupsOrganized: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (repo, userId, rowCap) => repo.cleanupsOrganized(userId, rowCap),
  },

  cleanupsJoined: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (repo, userId, rowCap) => repo.cleanupsJoined(userId, rowCap),
  },

  following: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (repo, userId, rowCap) => repo.following(userId, rowCap),
    present: (row: FollowingExportRow) => row.followee_id,
  },

  followers: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (repo, userId, rowCap) => repo.followers(userId, rowCap),
    present: (row: FollowerExportRow) => row.follower_id,
  },

  blocks: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (repo, userId, rowCap) => repo.blocks(userId, rowCap),
    present: (row: BlockExportRow) => row.blocked_id,
  },

  notificationPrefs: {
    kind: "record",
    load: (repo, userId) => repo.notificationPrefs(userId),
  },

  pushTokens: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (repo, userId, rowCap) => repo.pushTokens(userId, rowCap),
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
    load: (repo, userId, rowCap) => repo.certificates(userId, rowCap),
  },

  organizations: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (repo, userId, rowCap) => repo.organizations(userId, rowCap),
  },

  eventTeamMemberships: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (repo, userId, rowCap) => repo.eventTeamMemberships(userId, rowCap),
  },

  eventConsents: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (repo, userId, rowCap) => repo.eventConsents(userId, rowCap),
  },

  eventRegistrations: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (repo, userId, rowCap) => repo.eventRegistrations(userId, rowCap),
  },

  eventAnswers: {
    kind: "section",
    rowCap: DATA_EXPORT_FREE_TEXT_MAX_ROWS,
    load: (repo, userId, rowCap) => repo.eventAnswers(userId, rowCap),
  },

  eventCheckins: {
    kind: "section",
    rowCap: DATA_EXPORT_MAX_ROWS,
    load: (repo, userId, rowCap) => repo.eventCheckins(userId, rowCap),
  },
}

function loadBodyPart(
  repo: DataExportRepository,
  userId: string,
  key: BodyKey,
): PromiseLike<readonly object[]> {
  const part = DATA_EXPORT_BODY[key]
  return part.kind === "section" ? part.load(repo, userId, part.rowCap) : part.load(repo, userId)
}

/** Queries run in body order: the statements go out in the same sequence on every export. */
async function loadBody(
  repo: DataExportRepository,
  userId: string,
): Promise<Map<BodyKey, readonly object[]>> {
  const loaded = await Promise.all(
    DATA_EXPORT_BODY_ORDER.map((key) => loadBodyPart(repo, userId, key)),
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
  for (const name of EXHAUSTIVE_FIT_ORDER) {
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
  const repo = makeDrizzleDataExportRepository(sql)

  /**
   * The operator-visible trail for an export that has to be fulfilled by hand. Written before any notice
   * so the request is on record even if the notice fails. Carries no address or export content.
   */
  async function recordUndeliverable(userId: string, kind: DataExportUndeliverable): Promise<void> {
    await insertAuditRow(sql, {
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
      const profile = await repo.profile(userId)
      const loaded = await loadBody(repo, userId)
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
