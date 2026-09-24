import { describe, it, expect } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import type { Sql } from "../../src/db/client.js"
import { makeFakeSql, type RecordedStatement } from "../helpers/fake-sql.js"
import { makeDataExportService } from "../../src/services/data-export-service.js"

// BE-TEST-048. The data export is a privacy contract: what leaves the building is exactly what these
// SELECT projections name. Adding a column to any of them must be a deliberate, reviewed change to this
// file, so the projections are pinned verbatim rather than checked for "contains".

const USER_ID = "11111111-1111-1111-1111-111111111111"
const EMAIL = "jane@example.com"

const ROW = {
  id: "row-1",
  email: EMAIL,
  followee_id: "user-followee",
  follower_id: "user-follower",
  blocked_id: "user-blocked",
  platform: "ios",
  created_at: "2026-01-01T00:00:00.000Z",
  revoked_at: null,
}

const EXPECTED_PROJECTIONS: ReadonlyArray<readonly [from: string, columns: string]> = [
  [
    "users",
    "id, display_name, handle, email, email_verified, bio, avatar_url, donation_url, created_at, deleted_at",
  ],
  ["reports", "r.id, r.category, r.title, r.description, j.name AS place, r.status, r.created_at"],
  [
    "posts",
    "id, kind, body, visibility, reply_to_id, repost_of_id, created_at, updated_at, deleted_at",
  ],
  ["chat_messages", "id, cleanup_id, report_id, group_id, body, created_at, deleted_at"],
  ["dm_messages", "id, thread_id, body, created_at, deleted_at"],
  [
    "volunteer_hours",
    "id, source, report_id, cleanup_id, jurisdiction_geoid, hours::float8 AS hours, logged_by_user_id, created_at",
  ],
  ["cleanups", "id, title, created_at"],
  ["cleanup_members", "cleanup_id, role, joined_at"],
  ["follows_people", "followee_id"],
  ["follows_people", "follower_id"],
  ["user_blocks", "blocked_id"],
  [
    "notification_prefs",
    "user_id, push, cleanup_chat, report_updates, follows, quiet_start, quiet_end, mentions, host_broadcasts",
  ],
  ["push_tokens", "id, platform, created_at, revoked_at"],
  [
    "service_hours_certificates",
    "code, locale, holder_name, holder_handle, total_hours::float8 AS total_hours, entry_count, period_start, period_end, document_sha256, byte_size, issued_at, revoked_at, revoked_reason",
  ],
  ["organization_members", "om.organization_id, o.slug, o.name, om.role, om.joined_at"],
  ["cleanup_members", "cleanup_id, role, joined_at"],
  [
    "event_consents",
    "cleanup_id, terms_version, disclosure_version, host_contact_opt_in, sms_opt_in, accepted_at",
  ],
  [
    "cleanup_registrations",
    "r.id, r.cleanup_id, t.name AS ticket_type_name, r.party_size, r.status, r.source, r.registered_at, r.cancelled_at",
  ],
  [
    "cleanup_answers",
    "a.cleanup_id, q.prompt, COALESCE(a.value_text, a.value_json::text) AS value",
  ],
  ["cleanup_registration_seats", "s.cleanup_id, s.seat_index, s.checked_in_at, s.checkin_method"],
]

const EXPECTED_TOP_LEVEL_KEYS = [
  "exportedAt",
  "format",
  "userId",
  "profile",
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
  "truncated",
]

const FORBIDDEN_COLUMN =
  /\b(token|token_hash|code_hash|documents|secret|provider_user_id|r2_key|snapshot)\b/i

function projection(statement: RecordedStatement): readonly [string, string] {
  const normalized = statement.sql.replace(/\s+/g, " ").trim()
  const match = /^SELECT (.*?) FROM ([a-z_]+)\b/i.exec(normalized)
  if (!match) throw new Error(`not a SELECT ... FROM statement: ${normalized}`)
  return [match[2]!, match[1]!]
}

async function runExport(): Promise<{
  statements: RecordedStatement[]
  exported: Record<string, unknown>
}> {
  const fake = makeFakeSql([{ match: /SELECT/, rows: [ROW] }])
  const mailer = new FakeMailer()
  const service = makeDataExportService({
    sql: fake.sql as unknown as Sql,
    mailer,
    fromNoReply: "no-reply@civfix.org",
    supportEmail: "support@civfix.org",
  })
  const result = await service.exportData(USER_ID)
  expect(result).toEqual({ ok: true, email: EMAIL })
  const attachment = mailer.lastOutbound()!.attachments![0]!
  const exported = JSON.parse(new TextDecoder().decode(attachment.content)) as Record<
    string,
    unknown
  >
  return { statements: fake.statements, exported }
}

describe("data export field set (BE-TEST-048)", () => {
  it("runs exactly these SELECT projections, in this order, keyed by their FROM table", async () => {
    const { statements } = await runExport()
    expect(statements.map(projection)).toEqual(EXPECTED_PROJECTIONS)
  })

  it("scopes every statement to the exporting user", async () => {
    const { statements } = await runExport()
    for (const statement of statements) {
      expect(statement.values[0]).toBe(USER_ID)
    }
  })

  it("never selects a secret-bearing or out-of-scope column", async () => {
    const { statements } = await runExport()
    for (const statement of statements) {
      const [, columns] = projection(statement)
      expect(columns).not.toMatch(FORBIDDEN_COLUMN)
    }
  })

  it("the forbidden-column guard is word-bounded (push_tokens as a table is not a hit)", () => {
    expect("id, platform FROM push_tokens").not.toMatch(FORBIDDEN_COLUMN)
    expect("id, token FROM push_tokens").toMatch(FORBIDDEN_COLUMN)
    expect("code_hash").toMatch(FORBIDDEN_COLUMN)
  })

  it("produces the export object with exactly this top-level key order", async () => {
    const { exported } = await runExport()
    expect(Object.keys(exported)).toEqual(EXPECTED_TOP_LEVEL_KEYS)
    expect(exported.format).toBe("civfix-data-export@1")
    expect(exported.userId).toBe(USER_ID)
    expect(exported.truncated).toBeNull()
  })

  it("yields one row per scripted section, and flattens the social graph to ids", async () => {
    const { exported } = await runExport()
    expect(exported.profile).toEqual(ROW)
    expect(exported.notificationPrefs).toEqual(ROW)
    expect(exported.following).toEqual(["user-followee"])
    expect(exported.followers).toEqual(["user-follower"])
    expect(exported.blocks).toEqual(["user-blocked"])
    for (const section of [
      "reports",
      "posts",
      "chatMessages",
      "dmMessages",
      "volunteerHours",
      "cleanupsOrganized",
      "cleanupsJoined",
      "certificates",
      "organizations",
      "eventTeamMemberships",
      "eventConsents",
      "eventRegistrations",
      "eventAnswers",
      "eventCheckins",
    ]) {
      expect(exported[section], section).toEqual([ROW])
    }
  })

  it("pins (known-questionable) comments as a hardcoded empty section with no query behind it", async () => {
    const { statements, exported } = await runExport()
    expect(exported.comments).toEqual([])
    expect(statements.some((s) => /\bcomments\b/i.test(s.sql))).toBe(false)
  })

  it("redacts push tokens to this exact shape", async () => {
    const { exported } = await runExport()
    expect(exported.pushTokens).toEqual([
      {
        id: "row-1",
        platform: "ios",
        token: "[REDACTED]",
        createdAt: "2026-01-01T00:00:00.000Z",
        revokedAt: null,
      },
    ])
  })
})
