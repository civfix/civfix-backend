import type {
  CheckinMethod,
  EventPageBlock,
  EventPageSeo,
  EventQuestionCondition,
  EventQuestionKind,
  EventQuestionOption,
  EventPageStatus,
  RegistrationSource,
  RegistrationStatus,
  SeatStatus,
  ThemeAccent,
  TicketTypeVisibility,
  WaitlistStatus,
} from "@civfix/shared"
import type { Queryable } from "../../db/client.js"
import type {
  AnswerRecord,
  PageRecord,
  QuestionRecord,
  RegistrantIdentity,
  RegistrationRecord,
  SeatRecord,
  TicketTypeRecord,
  WaitlistRecord,
} from "./registration-repository.types.js"

export const PG_UNIQUE_VIOLATION = "23505"

export const PG_CHECK_VIOLATION = "23514"

export const RESERVED_SEATS_BACKSTOP_CONSTRAINT = "cleanup_ticket_types_reserved_bounds"

export const ANSWER_PREVIEW_MAX = 120

export interface PgErrorShape {
  code?: unknown
  constraint_name?: unknown
}

export function pgErrorConstraint(err: unknown): { code: string; constraint: string } | null {
  if (typeof err !== "object" || err === null) return null
  const e = err as PgErrorShape
  if (typeof e.code !== "string") return null
  return {
    code: e.code,
    constraint: typeof e.constraint_name === "string" ? e.constraint_name : "",
  }
}

export function isUniqueViolationOn(err: unknown, ...constraints: string[]): boolean {
  const parsed = pgErrorConstraint(err)
  if (parsed === null || parsed.code !== PG_UNIQUE_VIOLATION) return false
  return constraints.length === 0 || constraints.includes(parsed.constraint)
}

export const SALES_WINDOW_CONSTRAINT = "cleanup_ticket_types_sales_window"

export function isCheckViolationOn(err: unknown, constraint: string): boolean {
  const parsed = pgErrorConstraint(err)
  return parsed !== null && parsed.code === PG_CHECK_VIOLATION && parsed.constraint === constraint
}

export function isReservedSeatsBackstopViolation(err: unknown): boolean {
  const parsed = pgErrorConstraint(err)
  return (
    parsed !== null &&
    parsed.code === PG_CHECK_VIOLATION &&
    parsed.constraint === RESERVED_SEATS_BACKSTOP_CONSTRAINT
  )
}

export interface TicketTypeRowSelect {
  id: string
  cleanup_id: string
  name: string
  description: string | null
  capacity: number | null
  reserved_seats: number
  sold: number
  sales_opens_at: Date | null
  sales_closes_at: Date | null
  visibility: TicketTypeVisibility
  has_access_code: boolean
  max_party_size: number
  sort_order: number
  waitlist_enabled: boolean
  question_ids: string[] | null
}

export function toTicketTypeRecord(r: TicketTypeRowSelect): TicketTypeRecord {
  return {
    id: r.id,
    cleanupId: r.cleanup_id,
    name: r.name,
    description: r.description,
    capacity: r.capacity,
    reservedSeats: r.reserved_seats,
    sold: r.sold,
    salesOpensAt: r.sales_opens_at,
    salesClosesAt: r.sales_closes_at,
    visibility: r.visibility,
    accessCodeSet: r.has_access_code,
    maxPartySize: r.max_party_size,
    sortOrder: r.sort_order,
    waitlistEnabled: r.waitlist_enabled,
    questionIds: r.question_ids ?? [],
  }
}

export function ticketTypeColumns(tag: Queryable) {
  return tag`
    t.id,
    t.cleanup_id,
    t.name,
    t.description,
    t.capacity,
    t.reserved_seats,
    COALESCE(sold.n, 0)::int AS sold,
    t.sales_opens_at,
    t.sales_closes_at,
    t.visibility,
    (t.access_code_hash IS NOT NULL) AS has_access_code,
    t.max_party_size,
    t.sort_order,
    t.waitlist_enabled,
    qs.ids AS question_ids
  `
}

export function ticketTypeJoins(tag: Queryable) {
  return tag`
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(r.party_size), 0)::int AS n
        FROM cleanup_registrations r
       WHERE r.ticket_type_id = t.id AND r.status = 'registered'
    ) sold ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(q.id ORDER BY q.sort_order, q.id) AS ids
        FROM cleanup_questions q
       WHERE q.ticket_type_id = t.id AND q.archived_at IS NULL
    ) qs ON true
  `
}

export interface QuestionRowSelect {
  id: string
  cleanup_id: string
  ticket_type_id: string | null
  kind: EventQuestionKind
  prompt: string
  help_text: string | null
  required: boolean
  options: EventQuestionOption[] | null
  max_selections: number | null
  consent_text: string | null
  show_if: EventQuestionCondition | null
  sort_order: number
  archived_at: Date | null
}

export function toQuestionRecord(r: QuestionRowSelect): QuestionRecord {
  return {
    id: r.id,
    cleanupId: r.cleanup_id,
    ticketTypeId: r.ticket_type_id,
    kind: r.kind,
    prompt: r.prompt,
    helpText: r.help_text,
    required: r.required,
    options: r.options ?? [],
    maxSelections: r.max_selections,
    consentText: r.consent_text,
    showIf: r.show_if,
    sortOrder: r.sort_order,
    archivedAt: r.archived_at,
  }
}

export function questionColumns(tag: Queryable) {
  return tag`
    id, cleanup_id, ticket_type_id, kind, prompt, help_text, required,
    options, max_selections, consent_text, show_if, sort_order, archived_at
  `
}

export interface SeatRowSelect {
  id: string
  registration_id: string
  seat_index: number
  attendee_name: string | null
  status: SeatStatus
  checked_in_at: Date | null
  checked_in_by: string | null
  checkin_method: CheckinMethod | null
  checkin_coarsened_at: Date | null
  no_show_at: Date | null
}

export function toSeatRecord(r: SeatRowSelect): SeatRecord {
  return {
    id: r.id,
    registrationId: r.registration_id,
    seatIndex: r.seat_index,
    attendeeName: r.attendee_name,
    status: r.status,
    checkedInAt: r.checked_in_at,
    checkedInBy: r.checked_in_by,
    checkinMethod: r.checkin_method,
    checkinCoarsenedAt: r.checkin_coarsened_at,
    noShowAt: r.no_show_at,
  }
}

export function seatColumns(tag: Queryable) {
  return tag`
    id, registration_id, seat_index, attendee_name, status,
    checked_in_at, checked_in_by, checkin_method, checkin_coarsened_at, no_show_at
  `
}

export interface RegistrationRowSelect {
  id: string
  cleanup_id: string
  ticket_type_id: string | null
  ticket_type_name: string | null
  user_id: string | null
  guest_id: string | null
  guest_name: string | null
  party_size: number
  status: RegistrationStatus
  source: RegistrationSource
  host_note: string | null
  registered_at: Date
  cancelled_at: Date | null
  checked_in_at: Date | null
  slot_id: string | null
  slot_title: string | null
  answers_preview: string | null
  person_display_name: string | null
  person_handle: string | null
  person_bio: string | null
  person_avatar_url: string | null
  person_deleted_at: Date | null
}

function toIdentity(r: RegistrationRowSelect): RegistrantIdentity | null {
  if (r.user_id === null) return null
  return {
    userId: r.user_id,
    displayName: r.person_display_name,
    handle: r.person_handle,
    bio: r.person_bio,
    avatarUrl: r.person_avatar_url,
    deletedAt: r.person_deleted_at,
  }
}

export function toRegistrationRecord(
  r: RegistrationRowSelect,
  seats: SeatRecord[],
): RegistrationRecord {
  return {
    id: r.id,
    cleanupId: r.cleanup_id,
    ticketTypeId: r.ticket_type_id,
    ticketTypeName: r.ticket_type_name,
    userId: r.user_id,
    guestId: r.guest_id,
    guestName: r.guest_name,
    identity: toIdentity(r),
    partySize: r.party_size,
    status: r.status,
    source: r.source,
    hostNote: r.host_note,
    registeredAt: r.registered_at,
    cancelledAt: r.cancelled_at,
    checkedInAt: r.checked_in_at,
    slotId: r.slot_id,
    slotTitle: r.slot_title,
    seats,
    answersPreview: r.answers_preview,
  }
}

export function registrationColumns(tag: Queryable) {
  return tag`
    r.id,
    r.cleanup_id,
    r.ticket_type_id,
    tt.name AS ticket_type_name,
    r.user_id,
    r.guest_id,
    g.name AS guest_name,
    r.party_size,
    r.status,
    r.source,
    r.host_note,
    r.registered_at,
    r.cancelled_at,
    ci.first_at AS checked_in_at,
    sc.slot_id,
    sl.title AS slot_title,
    ap.preview AS answers_preview,
    u.display_name AS person_display_name,
    u.handle AS person_handle,
    u.bio AS person_bio,
    u.avatar_url AS person_avatar_url,
    u.deleted_at AS person_deleted_at
  `
}

export function registrationJoins(tag: Queryable) {
  return tag`
    LEFT JOIN cleanup_ticket_types tt ON tt.id = r.ticket_type_id
    LEFT JOIN cleanup_guests g ON g.id = r.guest_id
    LEFT JOIN users u ON u.id = r.user_id
    LEFT JOIN cleanup_slot_claims sc
      ON sc.cleanup_id = r.cleanup_id AND sc.user_id = r.user_id
    LEFT JOIN cleanup_slots sl ON sl.id = sc.slot_id
    LEFT JOIN LATERAL (
      SELECT min(s.checked_in_at) AS first_at
        FROM cleanup_registration_seats s
       WHERE s.registration_id = r.id AND s.checked_in_at IS NOT NULL
    ) ci ON true
    LEFT JOIN LATERAL (
      SELECT left(string_agg(a.value_text, ' | ' ORDER BY a.created_at), ${ANSWER_PREVIEW_MAX}) AS preview
        FROM cleanup_answers a
       WHERE a.registration_id = r.id AND a.scrubbed_at IS NULL AND a.value_text IS NOT NULL
    ) ap ON true
  `
}

export interface AnswerRowSelect {
  question_id: string
  prompt: string
  value_text: string | null
  value_json: unknown | null
  scrubbed_at: Date | null
}

export function toAnswerRecord(r: AnswerRowSelect): AnswerRecord {
  return {
    questionId: r.question_id,
    prompt: r.prompt,
    valueText: r.value_text,
    valueJson: r.value_json,
    scrubbedAt: r.scrubbed_at,
  }
}

export interface WaitlistRowSelect {
  id: string
  cleanup_id: string
  ticket_type_id: string
  ticket_type_name: string | null
  user_id: string | null
  guest_id: string | null
  guest_name: string | null
  party_size: number
  status: WaitlistStatus
  position: number | null
  created_at: Date
  offered_at: Date | null
  claim_expires_at: Date | null
  person_display_name: string | null
  person_handle: string | null
  person_bio: string | null
  person_avatar_url: string | null
  person_deleted_at: Date | null
}

export function toWaitlistRecord(r: WaitlistRowSelect): WaitlistRecord {
  return {
    id: r.id,
    cleanupId: r.cleanup_id,
    ticketTypeId: r.ticket_type_id,
    ticketTypeName: r.ticket_type_name,
    userId: r.user_id,
    guestId: r.guest_id,
    guestName: r.guest_name,
    identity:
      r.user_id === null
        ? null
        : {
            userId: r.user_id,
            displayName: r.person_display_name,
            handle: r.person_handle,
            bio: r.person_bio,
            avatarUrl: r.person_avatar_url,
            deletedAt: r.person_deleted_at,
          },
    partySize: r.party_size,
    status: r.status,
    position: r.position,
    createdAt: r.created_at,
    offeredAt: r.offered_at,
    claimExpiresAt: r.claim_expires_at,
  }
}

export function waitlistColumns(tag: Queryable) {
  return tag`
    w.id,
    w.cleanup_id,
    w.ticket_type_id,
    tt.name AS ticket_type_name,
    w.user_id,
    w.guest_id,
    g.name AS guest_name,
    w.party_size,
    w.status,
    pos.n AS position,
    w.created_at,
    w.offered_at,
    w.claim_expires_at,
    u.display_name AS person_display_name,
    u.handle AS person_handle,
    u.bio AS person_bio,
    u.avatar_url AS person_avatar_url,
    u.deleted_at AS person_deleted_at
  `
}

export function waitlistJoins(tag: Queryable) {
  return tag`
    LEFT JOIN cleanup_ticket_types tt ON tt.id = w.ticket_type_id
    LEFT JOIN cleanup_guests g ON g.id = w.guest_id
    LEFT JOIN users u ON u.id = w.user_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int + 1 AS n
        FROM cleanup_waitlist w2
       WHERE w2.ticket_type_id = w.ticket_type_id
         AND w2.status = 'waiting'
         AND (w2.created_at, w2.id) < (w.created_at, w.id)
    ) pos ON w.status = 'waiting'
  `
}

export interface PageRowSelect {
  cleanup_id: string
  slug: string | null
  status: EventPageStatus
  theme_accent: ThemeAccent
  blocks: EventPageBlock[] | null
  seo: EventPageSeo | null
  cover_media_id: string | null
  cover_key: string | null
  visibility: PageRecord["visibility"]
  published_at: Date | null
  updated_at: Date | null
  flagged_at: Date | null
  flag_reason: string | null
  view_count: string | number
}

export const DEFAULT_PAGE_SEO: EventPageSeo = { noindex: false }

export function toPageRecord(r: PageRowSelect): PageRecord {
  return {
    cleanupId: r.cleanup_id,
    slug: r.slug,
    status: r.status,
    themeAccent: r.theme_accent,
    blocks: r.blocks ?? [],
    seo: r.seo ?? DEFAULT_PAGE_SEO,
    coverMediaId: r.cover_media_id,
    coverKey: r.cover_key,
    visibility: r.visibility,
    publishedAt: r.published_at,
    updatedAt: r.updated_at,
    flaggedAt: r.flagged_at,
    flagReason: r.flag_reason,
    viewCount: typeof r.view_count === "string" ? Number(r.view_count) : r.view_count,
  }
}

export async function hostTeamUserIds(
  tag: Queryable,
  cleanupId: string,
  limit: number,
): Promise<string[]> {
  const rows = await tag<{ user_id: string }[]>`
    SELECT user_id FROM cleanup_members
     WHERE cleanup_id = ${cleanupId}
       AND role IN ('organizer', 'cohost', 'coordinator', 'staff')
     ORDER BY joined_at
     LIMIT ${limit}
  `
  return rows.map((r) => r.user_id)
}
