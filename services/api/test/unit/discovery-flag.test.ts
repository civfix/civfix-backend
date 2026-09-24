import { describe, expect, it } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import { makeDrizzleDiscoveryRepository } from "../../src/services/admin/discovery-repository.drizzle.js"
import { InMemoryDiscoveryRepository } from "../../src/services/admin/discovery-repository.memory.js"
import type { Sql } from "../../src/db/client.js"

const TASK_ID = "11111111-1111-1111-1111-111111111111"
const REPORT_ID = "22222222-2222-2222-2222-222222222222"

function flat(sql: string): string {
  return sql.replace(/\s+/g, " ").trim()
}

describe("flagging a discovery task", () => {
  it("never re-opens a done task (the open-task unique index would reject it)", async () => {
    const repo = new InMemoryDiscoveryRepository()
    repo.seedTask({ id: TASK_ID, geoid: "0644000", place: "Los Angeles", status: "done" })
    expect(await repo.flagTask(TASK_ID, { reason: null, actorId: null })).toBe(true)
    expect(repo.tasks.get(TASK_ID)?.task.status).toBe("done")
  })

  it("still moves an open task to in_progress", async () => {
    const repo = new InMemoryDiscoveryRepository()
    repo.seedTask({ id: TASK_ID, geoid: "0644000", place: "Los Angeles", status: "new" })
    await repo.flagTask(TASK_ID, { reason: null, actorId: null })
    expect(repo.tasks.get(TASK_ID)?.task.status).toBe("in_progress")
  })

  it("guards the status update and does not stack a second open manual flag on the report", async () => {
    const fake = makeFakeSql([
      {
        match: /SELECT sample_report_id FROM jurisdiction_discovery_tasks/,
        rows: [{ sample_report_id: REPORT_ID }],
      },
      { match: /INSERT INTO audit_log/, rows: [{ id: "audit-1" }] },
    ])
    const repo = makeDrizzleDiscoveryRepository(fake.sql as unknown as Sql)
    expect(await repo.flagTask(TASK_ID, { reason: "spam", actorId: null })).toBe(true)

    const statements = fake.statements.map((s) => flat(s.sql))
    expect(statements[0]).toMatch(/FOR UPDATE$/)
    const insert = statements.find((s) => s.startsWith("INSERT INTO abuse_flags"))
    expect(insert).toMatch(
      /WHERE NOT EXISTS \( SELECT 1 FROM abuse_flags WHERE subject_type = 'report' AND subject_id = \? AND reason = 'manual' AND resolved_at IS NULL \)/,
    )
    const update = statements.find((s) => s.startsWith("UPDATE jurisdiction_discovery_tasks"))
    expect(update).toMatch(/WHERE id = \? AND status <> 'done'$/)
  })
})
