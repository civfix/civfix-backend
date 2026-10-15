import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyMigrations } from "../../src/db/migrate.js"
import type { Sql } from "../../src/db/client.js"

const BACKEND_PID = 4242

interface FakeSession {
  pool: Sql
  released: () => boolean
  poolStatements: string[]
}

function fakeSession(opts: { failRollback: boolean }): FakeSession {
  let released = false
  let aborted = false
  const poolStatements: string[] = []
  const tag = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const text = strings.join("?")
    if (aborted) return Promise.reject(new Error("current transaction is aborted"))
    if (text.includes("pg_backend_pid")) return Promise.resolve([{ pid: BACKEND_PID }])
    if (text.includes("FROM _civfix_migrations")) return Promise.resolve([])
    return Promise.resolve([])
  }
  const reserved = Object.assign(tag, {
    unsafe: (text: string): Promise<unknown[]> => {
      if (text === "rollback") {
        if (opts.failRollback) return Promise.reject(new Error("connection lost mid-rollback"))
        aborted = false
        return Promise.resolve([])
      }
      if (text.includes("broken")) {
        aborted = true
        return Promise.reject(new Error("syntax error"))
      }
      return Promise.resolve([])
    },
    release: () => {
      released = true
    },
  })
  const pool = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      poolStatements.push(`${strings.join("?")} [${values.join(",")}]`)
      return Promise.resolve([])
    },
    { reserve: () => Promise.resolve(reserved) },
  ) as unknown as Sql
  return { pool, released: () => released, poolStatements }
}

describe("applyMigrations failure cleanup", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "civfix-migrate-"))
    await writeFile(join(dir, "0001_broken.sql"), "CREATE TABLE broken (")
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it("never hands a session that may still hold the migration lock back to the pool", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const session = fakeSession({ failRollback: true })

    await expect(applyMigrations(session.pool, dir)).rejects.toThrow("syntax error")

    expect(session.released()).toBe(false)
    expect(session.poolStatements.some((s) => s.includes("pg_terminate_backend"))).toBe(true)
    expect(session.poolStatements.join("\n")).toContain(String(BACKEND_PID))
    expect(errors).toHaveBeenCalled()
  })

  it("releases the session normally when the rollback succeeds", async () => {
    const session = fakeSession({ failRollback: false })
    await expect(applyMigrations(session.pool, dir)).rejects.toThrow("syntax error")
    expect(session.released()).toBe(true)
    expect(session.poolStatements).toHaveLength(0)
  })
})
