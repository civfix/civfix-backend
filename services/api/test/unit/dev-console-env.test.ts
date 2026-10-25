import { afterEach, describe, expect, it, vi } from "vitest"
import { FakeMailer } from "@civfix/seams"
import { loadEnv } from "../../src/env.js"
import { makeServer } from "../../src/server.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { makeAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"

const makeDb = vi.hoisted(() => vi.fn())
vi.mock("../../src/db/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/db/client.js")>()),
  makeDb,
}))

const { runDbCli } = await import("../../src/db/cli.js")

function validProdEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PORT: "8080",
    PUBLIC_API_URL: "https://api.civfix.org",
    WEB_ORIGINS: "https://civfix.org,https://app.civfix.org",
    DATABASE_URL: "postgres://user:pass@db:5432/civfix?sslmode=require",
    REDIS_URL: "redis://cache:6379",
    SESSION_SIGNING_KEY: "prod-session-signing-key-abcdefghijklmnop",
    ANON_TOKEN_SIGNING_KEY: "prod-anon-token-signing-key-abcdefghijklmnop",
    R2_ACCOUNT_ID: "acct",
    R2_ACCESS_KEY_ID: "akid",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "civfix-media",
    OCI_EMAIL_SMTP_HOST: "smtp.oci.example",
    OCI_EMAIL_SMTP_PORT: "587",
    OCI_EMAIL_SMTP_USER: "smtp-user",
    OCI_EMAIL_SMTP_PASS: "smtp-pass",
    TWILIO_ACCOUNT_SID: "ACtest",
    TWILIO_AUTH_TOKEN: "twilio-token",
    TWILIO_SMS_FROM: "+15550001111",
    UNSUBSCRIBE_SIGNING_KEY: "prod-unsubscribe-signing-key-abcdefghijklmnop",
    TICKET_TOKEN_SECRET: "prod-ticket-token-secret-abcdefghijklmnop",
  }
}

const TEST_ENV: NodeJS.ProcessEnv = { NODE_ENV: "test" }

const DEV_TOOLS_ON: NodeJS.ProcessEnv = {
  ...TEST_ENV,
  DEV_TOOLS_ENABLED: "true",
  CIVFIX_ENV: "staging",
  PUBLIC_API_URL: "https://api.civfix.dev",
}

const CODE_20 = "c".repeat(20)
const CODE_24 = "abcdefghijklmnopqrstuvwx"

// The loader reports each problem as a bulleted line under one header; these are the problems.
function problems(source: NodeJS.ProcessEnv): string[] {
  try {
    loadEnv(source)
  } catch (err) {
    return (err as Error).message
      .split("\n")
      .slice(1)
      .map((line) => line.replace(/^\s*- /, ""))
  }
  throw new Error("loadEnv did not throw")
}

function expectProblem(source: NodeJS.ProcessEnv, prefix: string): void {
  expect(problems(source).some((line) => line.startsWith(prefix))).toBe(true)
}

describe("loadEnv: the environment (D2)", () => {
  it("T1: CIVFIX_ENV=staging is staging", () => {
    expect(loadEnv({ ...TEST_ENV, CIVFIX_ENV: "staging" }).environment).toBe("staging")
  })

  it("T2: CIVFIX_ENV=prod in production is prod", () => {
    expect(loadEnv({ ...validProdEnv(), CIVFIX_ENV: "prod" }).environment).toBe("prod")
  })

  it("T3: unset or blank outside production is local", () => {
    expect(loadEnv({ NODE_ENV: "development" }).environment).toBe("local")
    expect(loadEnv({ NODE_ENV: "development", CIVFIX_ENV: "   " }).environment).toBe("local")
    expect(loadEnv({ NODE_ENV: "test" }).environment).toBe("local")
    expect(loadEnv({ NODE_ENV: "test", CIVFIX_ENV: "   " }).environment).toBe("local")
  })

  it("T4: unset or empty in production is unknown", () => {
    expect(loadEnv(validProdEnv()).environment).toBe("unknown")
    expect(loadEnv({ ...validProdEnv(), CIVFIX_ENV: "" }).environment).toBe("unknown")
  })

  it("T5: any other value refuses to boot", () => {
    for (const value of ["production", "Staging", "local"]) {
      expectProblem({ ...TEST_ENV, CIVFIX_ENV: value }, "CIVFIX_ENV:")
    }
  })
})

describe("loadEnv: dev tools (D9)", () => {
  it("T6: off unless DEV_TOOLS_ENABLED is set", () => {
    expect(loadEnv({ ...TEST_ENV, CIVFIX_ENV: "staging" }).devToolsEnabled).toBe(false)
  })

  it("T7: on for staging and for a local run", () => {
    expect(loadEnv(DEV_TOOLS_ON).devToolsEnabled).toBe(true)
    expect(loadEnv({ NODE_ENV: "development", DEV_TOOLS_ENABLED: "true" }).devToolsEnabled).toBe(
      true,
    )
  })

  it("T8: refused on prod", () => {
    expectProblem(
      { ...TEST_ENV, DEV_TOOLS_ENABLED: "true", CIVFIX_ENV: "prod" },
      "DEV_TOOLS_ENABLED:",
    )
  })

  it("T9: refused when the environment is unknown", () => {
    expectProblem({ ...validProdEnv(), DEV_TOOLS_ENABLED: "true" }, "DEV_TOOLS_ENABLED:")
  })

  it("T10: refused with the production API URL, in any case", () => {
    for (const url of ["https://api.civfix.org", "https://API.civfix.org/"]) {
      expectProblem({ ...DEV_TOOLS_ON, PUBLIC_API_URL: url }, "DEV_TOOLS_ENABLED:")
    }
  })

  it("T11: DEV_TOOLS_ENABLED=false boots on prod", () => {
    const env = loadEnv({ ...validProdEnv(), DEV_TOOLS_ENABLED: "false", CIVFIX_ENV: "prod" })
    expect(env.devToolsEnabled).toBe(false)
  })
})

describe("loadEnv: test accounts (D10)", () => {
  const T12_ENV: NodeJS.ProcessEnv = {
    ...DEV_TOOLS_ON,
    DEV_TEST_EMAILS: " A@civfix.org, b@gmail.com ,c@CIVFIX.org,d@civfix.org.evil.com,",
    DEV_TEST_OTP_CODE: CODE_24,
  }

  it("T12: keeps only civfix.org addresses, trimmed and lowercased, and counts the rest", () => {
    const env = loadEnv(T12_ENV)
    expect(env.DEV_TEST_EMAILS).toEqual(["a@civfix.org", "c@civfix.org"])
    expect(env.devTestEmailsDropped).toBe(2)
    expect(env.DEV_TEST_OTP_CODE).toBe(CODE_24)
  })

  it("T13: the API warns once at boot with the dropped count and logs no address", async () => {
    const lines: Record<string, unknown>[] = []
    const app = await makeServer({
      env: loadEnv(T12_ENV),
      authServices: makeAuthServices({
        stores: makeInMemoryStores(),
        cache: new InMemoryCacheClient(),
        mailer: new FakeMailer(),
        oauthConfig: {},
        verifier: new StubJwksVerifier(),
      }),
      logCapture: {
        level: "trace",
        stream: { write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>) },
      },
    })
    await app.ready()
    await app.close()

    const WARN = 40
    const carryingCount = lines.filter(
      (line) => line.level === WARN && Object.values(line).includes(2),
    )
    expect(carryingCount).toHaveLength(1)
    expect(JSON.stringify(lines)).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]+/i)
  })

  it("T14: refuses the reviewer address", () => {
    expectProblem(
      {
        ...DEV_TOOLS_ON,
        DEV_TEST_EMAILS: "reviewer@civfix.org,a@civfix.org",
        DEV_TEST_OTP_CODE: CODE_24,
      },
      "DEV_TEST_EMAILS:",
    )
  })

  it("T15: refuses an operator address, in any case", () => {
    expectProblem(
      {
        ...DEV_TOOLS_ON,
        ADMIN_EMAILS: "Ops@civfix.org",
        DEV_TEST_EMAILS: "ops@civfix.org",
        DEV_TEST_OTP_CODE: CODE_24,
      },
      "DEV_TEST_EMAILS:",
    )
  })

  it("T16: refuses addresses without a code of at least 20 characters", () => {
    const listed = { ...DEV_TOOLS_ON, DEV_TEST_EMAILS: "a@civfix.org" }
    expectProblem(listed, "DEV_TEST_OTP_CODE:")
    expectProblem({ ...listed, DEV_TEST_OTP_CODE: "c".repeat(19) }, "DEV_TEST_OTP_CODE:")
    expectProblem({ ...listed, DEV_TEST_OTP_CODE: `  ${"c".repeat(19)}  ` }, "DEV_TEST_OTP_CODE:")
  })

  it("T17: boots with a code of exactly 20 characters", () => {
    const env = loadEnv({
      ...DEV_TOOLS_ON,
      DEV_TEST_EMAILS: "a@civfix.org",
      DEV_TEST_OTP_CODE: CODE_20,
    })
    expect(env.DEV_TEST_EMAILS).toEqual(["a@civfix.org"])
  })

  it("T18: ignored entirely while dev tools are off", () => {
    const env = loadEnv({ ...TEST_ENV, DEV_TEST_EMAILS: "reviewer@civfix.org" })
    expect(env.DEV_TEST_EMAILS).toEqual([])
    expect(env.DEV_TEST_OTP_CODE).toBeUndefined()
  })
})

describe("loadEnv: build identity (D3)", () => {
  it("T19: trims the refs and treats empty values as unset", () => {
    const set = loadEnv({
      ...TEST_ENV,
      CIVFIX_RELEASE_REF: " v1.2.0 ",
      CIVFIX_API_IMAGE_REF: "ghcr.io/civfix/api@sha256:ab",
      CIVFIX_WORKER_IMAGE_REF: "ghcr.io/civfix/worker@sha256:cd",
    })
    expect(set.CIVFIX_RELEASE_REF).toBe("v1.2.0")
    expect(set.CIVFIX_API_IMAGE_REF).toBe("ghcr.io/civfix/api@sha256:ab")
    expect(set.CIVFIX_WORKER_IMAGE_REF).toBe("ghcr.io/civfix/worker@sha256:cd")

    const empty = loadEnv({
      ...TEST_ENV,
      CIVFIX_RELEASE_REF: "",
      CIVFIX_API_IMAGE_REF: "",
      CIVFIX_WORKER_IMAGE_REF: "",
    })
    expect(empty.CIVFIX_RELEASE_REF).toBeUndefined()
    expect(empty.CIVFIX_API_IMAGE_REF).toBeUndefined()
    expect(empty.CIVFIX_WORKER_IMAGE_REF).toBeUndefined()
  })
})

describe("runDbCli: migrate and seed run the same checks", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    makeDb.mockReset()
  })

  it("T20: refuses dev tools on prod before connecting", async () => {
    vi.stubEnv("NODE_ENV", "test")
    vi.stubEnv("DEV_TOOLS_ENABLED", "true")
    vi.stubEnv("CIVFIX_ENV", "prod")
    const body = vi.fn(() => Promise.resolve())

    await expect(runDbCli(body)).rejects.toThrow(/^\s*- DEV_TOOLS_ENABLED:/m)
    expect(body).not.toHaveBeenCalled()
    expect(makeDb).not.toHaveBeenCalled()
  })
})
