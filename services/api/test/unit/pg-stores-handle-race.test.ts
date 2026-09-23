import { describe, expect, it } from "vitest"
import { getTableColumns } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import * as schema from "../../src/db/schema/index.js"
import type { Db } from "../../src/db/client.js"
import { PgUserStore } from "../../src/auth/pg-stores.js"

const USER_ID = "88888888-8888-4888-8888-888888888888"
const NOW = new Date("2026-09-01T12:00:00.000Z")

interface Recorded {
  sql: string
  params: unknown[]
}

type Responder = (query: string, params: unknown[]) => unknown[][] | undefined

function recordingDb(respond: Responder): { db: Db; statements: Recorded[] } {
  const statements: Recorded[] = []
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(query: string, params: unknown[] = []) {
      statements.push({ sql: query, params })
      const rows = respond(query, params) ?? []
      const result = Promise.resolve<unknown[]>([]) as Promise<unknown[]> & {
        values(): Promise<unknown>
      }
      result.values = () => Promise.resolve(rows)
      return result
    },
    begin<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
      return callback(client)
    },
  }
  return { db: drizzle(client as never, { schema }), statements }
}

function userRow(fields: Record<string, unknown>): unknown[] {
  const base: Record<string, unknown> = {
    id: USER_ID,
    handle: "oldname",
    displayName: "Pat",
    role: "citizen",
    email: "pat@example.com",
    emailVerified: true,
    profileComplete: true,
    handleChangedAt: null,
    createdAt: NOW.toISOString(),
    ...fields,
  }
  return Object.keys(getTableColumns(schema.users)).map((key) => base[key] ?? null)
}

describe("PgUserStore.updateProfile under a concurrent rename", () => {
  it("guards the rename on the handle it read, and re-decides when another rename won", async () => {
    let userReads = 0
    const { db, statements } = recordingDb((query) => {
      if (/^select .* from "users" where "users"\."id" = \$1/i.test(query)) {
        userReads += 1
        return userReads === 1
          ? [userRow({})]
          : [userRow({ handle: "firstrename", handleChangedAt: NOW.toISOString() })]
      }
      if (/^update "users"/i.test(query)) return []
      return undefined
    })

    const store = new PgUserStore(db, { now: () => NOW })
    await expect(
      store.updateProfile(USER_ID, { handle: "secondrename", displayName: "Pat" }),
    ).rejects.toMatchObject({ httpStatus: 429 })

    const update = statements.find((s) => /^update "users"/i.test(s.sql))
    expect(update, "no UPDATE issued").toBeDefined()
    expect(update!.sql).toMatch(/"users"\."handle" = \$\d+/i)
    expect(update!.params).toContain("oldname")
  })
})
