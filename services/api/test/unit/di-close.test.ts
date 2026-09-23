import { describe, expect, it } from "vitest"
import { buildContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"

describe("DI container after close()", () => {
  it("refuses to reopen a database pool or hand out repositories bound to the closed one", async () => {
    const container = buildContainer(
      loadEnv({ NODE_ENV: "test", DATABASE_URL: "postgres://u:p@localhost:5432/civfix" }),
    )
    container.getVolunteerHoursRepo()
    container.getDmRepo()

    await container.close()

    expect(container.dbHandle).toBeUndefined()
    expect(() => container.getDb()).toThrow(/closed/)
    expect(() => container.getVolunteerHoursRepo()).toThrow(/closed/)
    expect(() => container.getDmRepo()).toThrow(/closed/)
    expect(container.dbHandle).toBeUndefined()
  })

  it("refuses to reopen Redis after close()", async () => {
    const container = buildContainer(
      loadEnv({ NODE_ENV: "test", REDIS_URL: "redis://localhost:6379" }),
    )

    await container.close()

    expect(() => container.getRedis()).toThrow(/closed/)
    expect(container.redis).toBeUndefined()
  })

  it("tolerates a second close()", async () => {
    const container = buildContainer(loadEnv({ NODE_ENV: "test" }))
    await container.close()
    await expect(container.close()).resolves.toBeUndefined()
  })
})
