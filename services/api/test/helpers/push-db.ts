import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import type { PushPlatform } from "@civfix/contract"
import type { Db } from "../../src/db/client.js"

export interface PushTokenRow {
  userId: string
  platform: PushPlatform
  token: string
  revokedAt?: Date
}

export interface FakePushDb {
  db: Db
  rows: PushTokenRow[]
  /** The bound parameters of each active-token select: the user ids it asked for. */
  selects: unknown[][]
  /** The bound parameters of each revoke: the tokens it revoked. */
  revokes: unknown[][]
}

const dialect = new PgDialect()

function paramsOf(condition: SQL): unknown[] {
  return dialect.sqlToQuery(condition).params
}

/**
 * Stands in for the Drizzle handle MultiPushSender uses: the select answers the active rows of the
 * users its condition names, and an update revokes the tokens its condition names.
 */
export function fakePushDb(rows: PushTokenRow[]): FakePushDb {
  const state: FakePushDb = { db: undefined as unknown as Db, rows, selects: [], revokes: [] }
  const db = {
    select() {
      let params: unknown[] = []
      const chain = {
        from: () => chain,
        where(condition: SQL) {
          params = paramsOf(condition)
          state.selects.push(params)
          return chain
        },
        orderBy: () => chain,
        limit: () =>
          Promise.resolve(
            rows
              .filter((r) => r.revokedAt === undefined && params.includes(r.userId))
              .map(({ userId, platform, token }) => ({ userId, platform, token })),
          ),
      }
      return chain
    },
    update() {
      let revokedAt: Date | undefined
      const chain = {
        set(values: { revokedAt?: Date }) {
          revokedAt = values.revokedAt
          return chain
        },
        where(condition: SQL) {
          const params = paramsOf(condition)
          state.revokes.push(params)
          for (const r of rows) {
            if (r.revokedAt === undefined && params.includes(r.token)) r.revokedAt = revokedAt
          }
          return Promise.resolve(undefined)
        },
      }
      return chain
    },
  }
  state.db = db as unknown as Db
  return state
}
