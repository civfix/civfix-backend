import { describe, expect, it } from "vitest"
import { makeContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"

describe("DI container after close()", () => {
  it("refuses to reopen a database pool or hand out repositories bound to the closed one", async () => {
    const container = makeContainer(
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
    const container = makeContainer(
      loadEnv({ NODE_ENV: "test", REDIS_URL: "redis://localhost:6379" }),
    )

    await container.close()

    expect(() => container.getRedis()).toThrow(/closed/)
    expect(container.redis).toBeUndefined()
  })

  it("lets a job still in flight during the graceful jobs stop reach the database", async () => {
    const container = makeContainer(
      loadEnv({ NODE_ENV: "test", DATABASE_URL: "postgres://u:p@localhost:5432/civfix" }),
    )
    const poolBeforeStop = container.getDb()
    let jobResult: unknown
    const runningJob = (async () => {
      await Promise.resolve()
      jobResult = {
        db: container.getDb(),
        repo: container.getVolunteerHoursRepo(),
      }
    })()
    Object.assign(container.jobs, { stop: () => runningJob })

    await container.close()

    expect(jobResult).toEqual({ db: poolBeforeStop, repo: expect.anything() })
    expect(container.dbHandle).toBeUndefined()
    expect(() => container.getDb()).toThrow(/closed/)
  })

  it("closes a pool a draining job opened, instead of leaking it", async () => {
    const container = makeContainer(
      loadEnv({ NODE_ENV: "test", DATABASE_URL: "postgres://u:p@localhost:5432/civfix" }),
    )
    Object.assign(container.jobs, {
      stop: async () => {
        container.getDb()
      },
    })

    await container.close()

    expect(container.dbHandle).toBeUndefined()
    expect(() => container.getDb()).toThrow(/closed/)
  })

  it("tolerates a second close()", async () => {
    const container = makeContainer(loadEnv({ NODE_ENV: "test" }))
    await container.close()
    await expect(container.close()).resolves.toBeUndefined()
  })
})
