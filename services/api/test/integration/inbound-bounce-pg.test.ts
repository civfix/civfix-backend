/**
 * Bounce handling against the REAL jurisdiction_contacts schema (Docker-gated).
 *
 * A DSN echoes the failed recipient exactly as the sending MTA recorded it, which is routinely a
 * different CASE from the address the operator saved ("Clerk@LACity.Gov" vs "clerk@lacity.gov").
 * markBouncedContact / geoidForContact used to compare `email = ${email}` verbatim while the ownership
 * guard right before them already folded case, so a case-mismatched DSN passed the guard and then
 * updated ZERO rows: no bounced_at stamp, no bounced badge in the directory, and no discovery
 * re-onboarding job. Every failure is silent, which is why it survived (the pre-existing bounce tests all
 * use an all-lowercase recipient and pass either way).
 *
 * These run against a template-cloned database, so the predicate and the functional
 * jurisdiction_contacts_email_lower_idx that keeps it off a seq scan (drizzle/0083) are the real ones.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import {
  geoidForContact,
  markBouncedContact,
  threadSentTo,
} from "../../src/services/admin/inbound-bounce.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()

const GEOID = LA_CITY.geoid
const SAVED = "clerk@lacity.gov"
const AS_DSN_ECHOED_IT = "Clerk@LACity.Gov"

describe.skipIf(!pg)("F111: bounce marking is case-insensitive (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE jurisdiction_contacts, mail_events, mail_messages, mail_threads RESTART IDENTITY CASCADE`
    await h.sql`
      INSERT INTO jurisdiction_contacts (geoid, category, email)
      VALUES (${GEOID}, NULL, ${SAVED})
    `
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function bouncedAt(): Promise<Date | null> {
    const rows = await h.sql<{ bounced_at: Date | null }[]>`
      SELECT bounced_at FROM jurisdiction_contacts WHERE geoid = ${GEOID} AND category IS NULL
    `
    return rows[0]?.bounced_at ?? null
  }

  it("stamps bounced_at when the DSN's recipient differs only in case", async () => {
    expect(await bouncedAt()).toBeNull()
    await markBouncedContact(h.sql, AS_DSN_ECHOED_IT, GEOID)
    expect(await bouncedAt()).not.toBeNull()
  })

  it("resolves the contact's geoid from a differently-cased recipient", async () => {
    expect(await geoidForContact(h.sql, AS_DSN_ECHOED_IT)).toBe(GEOID)
    expect(await geoidForContact(h.sql, "CLERK@LACITY.GOV")).toBe(GEOID)
  })

  it("still marks nothing for a genuinely different address", async () => {
    await markBouncedContact(h.sql, "someone-else@lacity.gov", GEOID)
    expect(await bouncedAt()).toBeNull()
    expect(await geoidForContact(h.sql, "someone-else@lacity.gov")).toBeNull()
  })

  it("agrees with the ownership guard, which already folded case (the pair must not diverge)", async () => {
    const [thread] = await h.sql<{ id: string }[]>`
      INSERT INTO mail_threads (subject, org, jurisdiction_geoid, thread_token)
      VALUES ('Pothole', 'City of LA', ${GEOID}, 'aaaaaaaaaaaaaaaaaaaaaaaa')
      RETURNING id
    `
    await h.sql`
      INSERT INTO mail_messages (thread_id, direction, from_addr, to_addr, body)
      VALUES (${thread!.id}, 'out', 'outreach@civfix.org', ${SAVED}, 'please review')
    `

    expect(await threadSentTo(h.sql, thread!.id, AS_DSN_ECHOED_IT)).toBe(true)
    await markBouncedContact(h.sql, AS_DSN_ECHOED_IT, GEOID)
    expect(await bouncedAt()).not.toBeNull()
  })
})
