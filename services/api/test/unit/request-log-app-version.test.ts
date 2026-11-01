import { afterEach, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { makeServer } from "../../src/server.js"
import { makeContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { makeRuntimeFlagService } from "../../src/services/admin/runtime-flag-service.js"
import { InMemoryRuntimeFlagRepository } from "../helpers/admin/runtime-flag-repository.memory.js"

interface LogLine {
  msg: string
  app_version?: unknown
}

describe("request log: app_version", () => {
  let app: FastifyInstance | undefined
  let lines: LogLine[]

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function serve(): Promise<FastifyInstance> {
    lines = []
    const env = loadEnv({ NODE_ENV: "test" })
    const flags = makeRuntimeFlagService({
      repo: new InMemoryRuntimeFlagRepository(),
      envFallbacks: env.runtimeFlagEnvFallbacks,
      logger: { warn: () => undefined, error: () => undefined },
    })
    const container: Container = { ...makeContainer(env), getRuntimeFlags: () => flags }
    app = await makeServer({
      env,
      container,
      logCapture: {
        level: "info",
        stream: { write: (line) => lines.push(JSON.parse(line) as LogLine) },
      },
    })
    app.get(
      "/__log-errored",
      {
        onResponse: async () => {
          throw new Error("onResponse hook failed")
        },
      },
      async () => ({ ok: true }),
    )
    await app.ready()
    return app
  }

  async function lineFor(header: string | undefined, url = "/v1/app/config"): Promise<LogLine> {
    const server = app ?? (await serve())
    lines.length = 0
    await server.inject({
      method: "GET",
      url,
      headers: header === undefined ? {} : { "x-civfix-app-version": header },
    })
    const written = lines.filter(
      (line) => line.msg === "request completed" || line.msg === "request errored",
    )
    expect(written).toHaveLength(1)
    return written[0]!
  }

  it("T53: carries a well-formed phone version", async () => {
    const ios = await lineFor("ios/1.4.0")
    expect(ios.msg).toBe("request completed")
    expect(ios.app_version).toBe("ios/1.4.0")
    expect((await lineFor("android/10.0.12")).app_version).toBe("android/10.0.12")
  })

  it("T54: leaves anything else off", async () => {
    for (const header of [
      "ios/1.4",
      "web/1.4.0",
      "IOS/1.4.0",
      "ios/1.4.0-beta",
      "ios/1.4.0 ",
      "",
    ]) {
      const line = await lineFor(header)
      expect(line.msg).toBe("request completed")
      expect("app_version" in line, JSON.stringify(header)).toBe(false)
    }
    expect("app_version" in (await lineFor(undefined))).toBe(false)
  })

  it("T55: carries it on a request errored line too", async () => {
    const line = await lineFor("android/2.0.0", "/__log-errored")
    expect(line.msg).toBe("request errored")
    expect(line.app_version).toBe("android/2.0.0")
  })
})
