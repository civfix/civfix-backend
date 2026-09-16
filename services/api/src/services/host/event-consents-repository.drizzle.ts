import { AppError, isCurrent, type ConsentSurface, type EventConsentInput } from "@civfix/shared"
import type { Queryable } from "../../db/client.js"

export interface EventConsentRow {
  id: string
  cleanupId: string
  subjectType: "user" | "guest"
  userId: string | null
  guestId: string | null
  registrationId: string | null
  termsVersion: string
  disclosureVersion: string
  hostContactOptIn: boolean
  smsOptIn: boolean
  surface: ConsentSurface | null
  acceptedAt: Date
}

export interface InsertConsentInput {
  cleanupId: string
  subjectType: "user" | "guest"
  userId: string | null
  guestId: string | null
  registrationId: string | null
  consent: EventConsentInput
  now: Date
}

export function assertCurrentConsentVersions(consent: EventConsentInput): void {
  const fields: Record<string, string> = {}
  if (!isCurrent("terms", consent.termsVersion)) {
    fields.termsVersion = "is out of date — reload and accept the current terms"
  }
  if (!isCurrent("privacy", consent.disclosureVersion)) {
    fields.disclosureVersion = "is out of date — reload and accept the current privacy notice"
  }
  if (Object.keys(fields).length > 0) throw AppError.validation(fields)
}

export async function insertConsent(
  tx: Queryable,
  input: InsertConsentInput,
): Promise<string> {
  assertCurrentConsentVersions(input.consent)
  if (input.subjectType === "user" && input.userId === null) {
    throw AppError.internal("event consent for a member needs a user id")
  }
  if (input.subjectType === "guest" && input.guestId === null) {
    throw AppError.internal("event consent for a guest needs a guest id")
  }
  const rows = await tx<{ id: string }[]>`
    INSERT INTO event_consents (
      cleanup_id, subject_type, user_id, guest_id, registration_id,
      terms_version, disclosure_version, host_contact_opt_in, sms_opt_in, surface, accepted_at
    ) VALUES (
      ${input.cleanupId},
      ${input.subjectType},
      ${input.subjectType === "user" ? input.userId : null},
      ${input.subjectType === "guest" ? input.guestId : null},
      ${input.registrationId},
      ${input.consent.termsVersion},
      ${input.consent.disclosureVersion},
      ${input.consent.hostContactOptIn},
      ${input.consent.smsOptIn ?? false},
      ${input.consent.surface ?? null},
      ${input.now}
    )
    RETURNING id
  `
  const row = rows[0]
  if (row === undefined) throw AppError.internal()
  return row.id
}

export async function listConsentsForUser(
  sql: Queryable,
  userId: string,
  limit: number,
): Promise<EventConsentRow[]> {
  const rows = await sql<
    {
      id: string
      cleanup_id: string
      subject_type: "user" | "guest"
      user_id: string | null
      guest_id: string | null
      registration_id: string | null
      terms_version: string
      disclosure_version: string
      host_contact_opt_in: boolean
      sms_opt_in: boolean
      surface: ConsentSurface | null
      accepted_at: Date
    }[]
  >`
    SELECT id, cleanup_id, subject_type, user_id, guest_id, registration_id,
           terms_version, disclosure_version, host_contact_opt_in, sms_opt_in, surface, accepted_at
    FROM event_consents
    WHERE user_id = ${userId}
    ORDER BY accepted_at DESC, id DESC
    LIMIT ${limit}
  `
  return rows.map((r) => ({
    id: r.id,
    cleanupId: r.cleanup_id,
    subjectType: r.subject_type,
    userId: r.user_id,
    guestId: r.guest_id,
    registrationId: r.registration_id,
    termsVersion: r.terms_version,
    disclosureVersion: r.disclosure_version,
    hostContactOptIn: r.host_contact_opt_in,
    smsOptIn: r.sms_opt_in,
    surface: r.surface,
    acceptedAt: r.accepted_at,
  }))
}

export async function hostContactOptInFor(
  sql: Queryable,
  cleanupId: string,
  subjectIds: { userIds: readonly string[]; guestIds: readonly string[] },
): Promise<Set<string>> {
  const out = new Set<string>()
  if (subjectIds.userIds.length === 0 && subjectIds.guestIds.length === 0) return out
  const rows = await sql<
    { user_id: string | null; guest_id: string | null; host_contact_opt_in: boolean }[]
  >`
    SELECT DISTINCT ON (COALESCE(user_id, guest_id))
           user_id, guest_id, host_contact_opt_in
    FROM event_consents
    WHERE cleanup_id = ${cleanupId}
      AND (
        user_id = ANY(${[...subjectIds.userIds]}::uuid[])
        OR guest_id = ANY(${[...subjectIds.guestIds]}::uuid[])
      )
    ORDER BY COALESCE(user_id, guest_id), accepted_at DESC, id DESC
  `
  for (const row of rows) {
    if (!row.host_contact_opt_in) continue
    if (row.user_id !== null) out.add(row.user_id)
    if (row.guest_id !== null) out.add(row.guest_id)
  }
  return out
}
