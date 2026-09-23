import { afterEach, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { makeServer } from "../../src/server.js"
import { makeContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { signAnonToken } from "../../src/abuse/anon-token.js"
import { InMemoryMediaRepository } from "../helpers/media.js"

const SHA = "c".repeat(64)
const TOKEN_ID = "33333333-3333-4333-8333-333333333333"

let app: FastifyInstance | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
})

async function uploadWithCookie(cookie: string | null): Promise<string[]> {
  const env = loadEnv({ NODE_ENV: "test" })
  const subjects: string[] = []
  const container = {
    ...makeContainer(env),
    env: { ...env, REDIS_URL: "redis://cache:6379" },
    getByteMeter: () => ({
      add: (subject: string, bytes: number) => {
        subjects.push(subject)
        return Promise.resolve(bytes)
      },
    }),
  } as unknown as ReturnType<typeof makeContainer>
  app = await makeServer({ env, container, mediaRepo: new InMemoryMediaRepository() })
  const res = await app.inject({
    method: "POST",
    url: "/v1/media/upload",
    ...(cookie !== null
      ? { headers: { cookie: `civfix_anon=${encodeURIComponent(cookie)}` } }
      : {}),
    payload: { kind: "image", contentType: "image/jpeg", byteSize: 1024, sha256: SHA },
  })
  expect(res.statusCode).toBe(200)
  return subjects
}

describe("anonymous subject from the civfix_anon cookie", () => {
  it("ignores an unsigned cookie value and meters the upload by IP only", async () => {
    const subjects = await uploadWithCookie("x".repeat(4000))

    expect(subjects.some((s) => s.startsWith("a:"))).toBe(false)
    expect(subjects.filter((s) => s.startsWith("ip:"))).toHaveLength(1)
  })

  it("ignores a cookie signed with a different key", async () => {
    const subjects = await uploadWithCookie(signAnonToken(TOKEN_ID, "some-other-signing-key"))

    expect(subjects.some((s) => s.startsWith("a:"))).toBe(false)
  })

  it("meters a validly signed cookie under its bare token id", async () => {
    const env = loadEnv({ NODE_ENV: "test" })
    const subjects = await uploadWithCookie(signAnonToken(TOKEN_ID, env.ANON_TOKEN_SIGNING_KEY))

    expect(subjects).toContain(`a:${TOKEN_ID}`)
    expect(subjects.filter((s) => s.startsWith("ip:"))).toHaveLength(1)
  })

  it("does not reject a request that carries a forged cookie", async () => {
    const subjects = await uploadWithCookie("forged.signature")

    expect(subjects.length).toBeGreaterThan(0)
  })
})
