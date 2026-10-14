import { describe, it, expect } from "vitest"
import { AppError, ErrorCode } from "@civfix/shared"
import { makeFakeSql } from "../helpers/fake-sql.js"
import type { Sql } from "../../src/db/client.js"
import { makeDrizzleAdminUserRepository } from "../../src/services/admin/admin-user-repository.drizzle.js"

const USER_ID = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e21"
const AUDIT_ROW = { match: /INSERT INTO audit_log/, rows: [{ id: "audit-1" }] }

function isForbidden(err: unknown): boolean {
  return err instanceof AppError && err.code === ErrorCode.FORBIDDEN
}

describe("admin user writes re-check the target inside the transaction", () => {
  it("refuses a role change when the row became an operator after the service pre-check", async () => {
    const ctl = makeFakeSql([
      { match: /SELECT role FROM users/, rows: [{ role: "operator" }] },
      AUDIT_ROW,
    ])
    const repo = makeDrizzleAdminUserRepository(ctl.sql as unknown as Sql)
    const outcome = await repo.applyRole(USER_ID, { role: "citizen", actorId: "op-1" }).then(
      () => "written",
      (err: unknown) => (isForbidden(err) ? "forbidden" : err),
    )
    expect(outcome).toBe("forbidden")
    expect(ctl.statements.some((s) => /UPDATE users SET role/.test(s.sql))).toBe(false)
  })

  it("locks the target row for the role write", async () => {
    const ctl = makeFakeSql([
      { match: /SELECT role FROM users/, rows: [{ role: "citizen" }] },
      AUDIT_ROW,
    ])
    const repo = makeDrizzleAdminUserRepository(ctl.sql as unknown as Sql)
    await expect(repo.applyRole(USER_ID, { role: "citizen", actorId: "op-1" })).resolves.toBe(true)
    const read = ctl.statements.find((s) => /SELECT role FROM users/.test(s.sql))
    expect(read?.sql).toMatch(/FOR NO KEY UPDATE/)
  })

  it("refuses a status change on a row that became an operator after the service pre-check", async () => {
    const ctl = makeFakeSql([
      { match: /FROM users WHERE id/, rows: [{ id: USER_ID, role: "operator" }] },
      AUDIT_ROW,
    ])
    const repo = makeDrizzleAdminUserRepository(ctl.sql as unknown as Sql)
    const outcome = await repo
      .setStatus(USER_ID, { status: "banned", reason: null, actorId: "op-1" })
      .then(
        () => "written",
        (err: unknown) => (isForbidden(err) ? "forbidden" : err),
      )
    expect(outcome).toBe("forbidden")
    expect(ctl.statements.some((s) => /INSERT INTO user_moderation/.test(s.sql))).toBe(false)
  })

  it("locks the target row without blocking foreign-key checks on it", async () => {
    const ctl = makeFakeSql([
      { match: /FROM users WHERE id/, rows: [{ id: USER_ID, role: "citizen" }] },
      AUDIT_ROW,
    ])
    const repo = makeDrizzleAdminUserRepository(ctl.sql as unknown as Sql)
    await repo.setStatus(USER_ID, { status: "suspended", reason: null, actorId: "op-1" })
    const lock = ctl.statements.find((s) => /SELECT id, role FROM users/.test(s.sql))
    expect(lock?.sql).toMatch(/FOR NO KEY UPDATE/)
  })
})

describe("admin user flag toggle serializes on the user row", () => {
  it("locks the user row before reading the current flag", async () => {
    const ctl = makeFakeSql([{ match: /SELECT id FROM users/, rows: [{ id: USER_ID }] }, AUDIT_ROW])
    const repo = makeDrizzleAdminUserRepository(ctl.sql as unknown as Sql)
    await repo.toggleFlag(USER_ID, { reason: null, actorId: "op-1" })
    const lock = ctl.statements.find((s) => /SELECT id FROM users/.test(s.sql))
    expect(lock?.sql).toMatch(/FOR NO KEY UPDATE/)
  })
})
