import { describe, expect, it } from "vitest"
import { getTableColumns } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import * as schema from "../../src/db/schema/index.js"
import type { Db } from "../../src/db/client.js"
import { PgSessionStore, PgUserStore } from "../../src/auth/pg-stores.js"

const USER_ID = "77777777-7777-4777-8777-777777777777"

interface Recorded {
  sql: string
  params: unknown[]
  inTransaction: boolean
}

type Responder = (query: string) => { rows?: unknown[][]; error?: Error }

// A postgres.js stand-in for drizzle: records every statement, marks the ones issued inside `begin`, and
// answers row arrays in the column order drizzle asks for.
function recordingDb(respond: Responder = () => ({})): { db: Db; statements: Recorded[] } {
  const statements: Recorded[] = []
  let inTransaction = false
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(query: string, params: unknown[] = []) {
      statements.push({ sql: query, params, inTransaction })
      const answer = respond(query)
      const settle = <T>(value: T): Promise<T> =>
        answer.error ? Promise.reject(answer.error) : Promise.resolve(value)
      const result = settle<unknown[]>([]) as Promise<unknown[]> & { values(): Promise<unknown> }
      result.catch(() => {})
      result.values = () => settle(answer.rows ?? [])
      return result
    },
    async begin<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
      inTransaction = true
      try {
        return await callback(client)
      } finally {
        inTransaction = false
      }
    },
  }
  return { db: drizzle(client as never, { schema }) as unknown as Db, statements }
}

function erasedUserRow(): unknown[] {
  return Object.keys(getTableColumns(schema.users)).map((key) => (key === "id" ? USER_ID : null))
}

function answerErasure(extra: Responder = () => ({})): Responder {
  return (query) => {
    const override = extra(query)
    if (override.rows || override.error) return override
    if (/^update "users"/i.test(query)) return { rows: [erasedUserRow()] }
    return {}
  }
}

function deleteOf(statements: Recorded[], table: string): Recorded | undefined {
  return statements.find((s) => new RegExp(`^delete from "${table}"`, "i").test(s.sql))
}

describe("account erasure revokes sessions and device reach atomically", () => {
  it.each(["sessions", "push_tokens", "notifications"])(
    "deletes the user's %s rows inside the erasure transaction",
    async (table) => {
      const { db, statements } = recordingDb(answerErasure())

      await new PgUserStore(db).softDeleteAndAnonymize(USER_ID)

      const statement = deleteOf(statements, table)
      expect(statement, `no DELETE FROM ${table}`).toBeDefined()
      expect(statement!.inTransaction).toBe(true)
      expect(statement!.sql).toMatch(new RegExp(`"${table}"\\."user_id" = \\$1`, "i"))
      expect(statement!.params).toEqual([USER_ID])
    },
  )

  it("fails the erasure instead of committing it when a revocation delete fails", async () => {
    const { db } = recordingDb(
      answerErasure((query) =>
        /^delete from "push_tokens"/i.test(query) ? { error: new Error("push_tokens down") } : {},
      ),
    )

    await expect(new PgUserStore(db).softDeleteAndAnonymize(USER_ID)).rejects.toMatchObject({
      cause: { message: "push_tokens down" },
    })
  })
})

describe("session lookup for a deleted account", () => {
  it("only resolves a session whose user is not soft-deleted", async () => {
    const { db, statements } = recordingDb()

    expect(await new PgSessionStore(db).findById("hash")).toBeNull()

    const lookup = statements.find((s) => /from "sessions"/i.test(s.sql))!
    expect(lookup.sql).toMatch(/inner join "users" on \(?"users"\."id" = "sessions"\."user_id"/i)
    expect(lookup.sql).toMatch(/"users"\."deleted_at" is null/i)
  })
})

describe("account erasure revokes the user's pending organization invites", () => {
  it("revokes invites the user sent or received, with an audit row each, inside the transaction", async () => {
    const { db, statements } = recordingDb(answerErasure())

    await new PgUserStore(db).softDeleteAndAnonymize(USER_ID)

    const membershipDelete = statements.findIndex((s) =>
      /delete from organization_members where user_id/i.test(s.sql),
    )
    const revokeAt = statements.findIndex((s) => /update organization_invites/i.test(s.sql))
    expect(revokeAt, "no organization_invites revocation").toBeGreaterThan(membershipDelete)
    expect(membershipDelete).toBeGreaterThanOrEqual(0)

    const revoke = statements[revokeAt]!
    const text = revoke.sql.replace(/\s+/g, " ")
    expect(revoke.inTransaction).toBe(true)
    expect(text).toMatch(/set status = 'revoked', revoked_at = now\(\)/i)
    expect(text).toMatch(/status = 'pending' and \(invited_by = \$1 or user_id = \$2\)/i)
    expect(text).toMatch(/insert into audit_log \(actor_id, action, target, meta\)/i)
    expect(text).toContain("'org.invite_revoked'")
    expect(text).toContain("'account_deleted'")
    expect(revoke.params.slice(0, 2)).toEqual([USER_ID, USER_ID])
  })
})

describe("account erasure takes attendee locks in the order the event ban takes them", () => {
  it("cancels the user's waitlist rows before it touches their registrations", async () => {
    const { db, statements } = recordingDb(answerErasure())

    await new PgUserStore(db).softDeleteAndAnonymize(USER_ID)

    const waitlistAt = statements.findIndex((s) => /update cleanup_waitlist/i.test(s.sql))
    const registrationAt = statements.findIndex((s) =>
      /update cleanup_registrations\b/i.test(s.sql),
    )
    const seatsAt = statements.findIndex((s) => /update cleanup_registration_seats/i.test(s.sql))
    const answersAt = statements.findIndex((s) => /update cleanup_answers/i.test(s.sql))
    expect(waitlistAt).toBeGreaterThanOrEqual(0)
    expect(registrationAt).toBeGreaterThan(waitlistAt)
    expect(seatsAt).toBeGreaterThan(waitlistAt)
    expect(answersAt).toBeGreaterThan(waitlistAt)
    expect(statements[waitlistAt]!.sql).toMatch(/update cleanup_ticket_types/i)
  })
})
