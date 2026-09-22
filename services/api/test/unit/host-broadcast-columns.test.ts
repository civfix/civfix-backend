import { describe, expect, it } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import type { Sql } from "../../src/db/client.js"
import { makeDrizzleBroadcastRepository } from "../../src/services/host/broadcast-repository.drizzle.js"

const USER_ID = "11111111-1111-1111-1111-111111111111"

async function hostMessagingStateStatement(emailVerified: boolean) {
  const fake = makeFakeSql([
    {
      match: /host_messaging_suspended/,
      rows: [{ suspended: false, email_verified: emailVerified, created_at: new Date(0) }],
    },
  ])
  const repo = makeDrizzleBroadcastRepository(fake.sql as unknown as Sql)
  const state = await repo.hostMessagingState(USER_ID)
  const stmt = fake.statements[0]
  expect(stmt, "hostMessagingState should emit a statement").toBeDefined()
  return { sql: stmt!.sql, state }
}

async function memberContactsStatement(emailVerified: boolean) {
  const fake = makeFakeSql([
    {
      match: /FROM users/,
      rows: [
        {
          id: USER_ID,
          email: "host@example.org",
          email_verified: emailVerified,
          display_name: "Ada Host",
          locale: "en",
        },
      ],
    },
  ])
  const repo = makeDrizzleBroadcastRepository(fake.sql as unknown as Sql)
  const contacts = await repo.memberContacts([USER_ID])
  const stmt = fake.statements[0]
  expect(stmt, "memberContacts should emit a statement").toBeDefined()
  return { sql: stmt!.sql, contact: contacts.get(USER_ID) }
}

describe("broadcast repository selects the columns users actually has", () => {
  it("hostMessagingState reads email_verified, never the phantom email_verified_at", async () => {
    const { sql } = await hostMessagingStateStatement(true)
    expect(sql).not.toMatch(/email_verified_at/)
    expect(sql).toMatch(/\bemail_verified\b/)
  })

  it("recipient identities read email_verified, never the phantom email_verified_at", async () => {
    const { sql } = await memberContactsStatement(true)
    expect(sql).not.toMatch(/email_verified_at/)
    expect(sql).toMatch(/\bemail_verified\b/)
  })

  it("hostMessagingState maps the boolean, so an unverified host stays unverified", async () => {
    const verified = await hostMessagingStateStatement(true)
    const unverified = await hostMessagingStateStatement(false)
    expect(verified.state?.emailVerified).toBe(true)
    expect(unverified.state?.emailVerified).toBe(false)
  })

  it("recipient identities map the boolean, so an unverified member stays unverified", async () => {
    const verified = await memberContactsStatement(true)
    const unverified = await memberContactsStatement(false)
    expect(verified.contact?.emailVerified).toBe(true)
    expect(unverified.contact?.emailVerified).toBe(false)
  })
})
