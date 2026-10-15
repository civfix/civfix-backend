import { describe, expect, it } from "vitest"
import { IdSchema } from "@civfix/shared"
import {
  CIVFIX_OFFICIAL_DISPLAY_NAME,
  CIVFIX_OFFICIAL_HANDLE,
  CIVFIX_OFFICIAL_USER_ID,
  isOfficialAccount,
} from "../../src/auth/official-account.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { sha256Hex } from "../../src/auth/crypto.js"
import { SessionService } from "../../src/auth/session-service.js"
import { InMemorySessionStore } from "../../src/auth/stores.js"
import { officialAccountMigrationSql } from "../helpers/official-account.js"

const OTHER_USER = "11111111-1111-1111-1111-111111111111"
const NOW_MS = 1_700_000_000_000

function makeSessions() {
  const store = new InMemorySessionStore()
  const cache = new InMemoryCacheClient(() => NOW_MS)
  const service = new SessionService({ store, cache, now: () => NOW_MS })
  return { store, cache, service }
}

describe("the official account identity", () => {
  it("is a valid id for every request schema that carries a user id", () => {
    expect(IdSchema.safeParse(CIVFIX_OFFICIAL_USER_ID).success).toBe(true)
  })

  it("matches its id in any letter case and nothing else", () => {
    expect(isOfficialAccount(CIVFIX_OFFICIAL_USER_ID)).toBe(true)
    expect(isOfficialAccount(CIVFIX_OFFICIAL_USER_ID.toUpperCase())).toBe(true)
    expect(isOfficialAccount(OTHER_USER)).toBe(false)
    expect(isOfficialAccount(null)).toBe(false)
    expect(isOfficialAccount(undefined)).toBe(false)
  })
})

describe("0180 migration stays in step with the code constants", () => {
  const migration = officialAccountMigrationSql()

  it("inserts the row under the constant id, handle and display name, with no email", () => {
    expect(migration.split(`'${CIVFIX_OFFICIAL_USER_ID}'`)).toHaveLength(3)
    expect(migration).toContain(`'${CIVFIX_OFFICIAL_HANDLE}'`)
    expect(migration).toContain(`'${CIVFIX_OFFICIAL_DISPLAY_NAME}'`)
    expect(migration).toContain("'The official CivFix account.'")
    expect(migration).toMatch(/'citizen',\s*'CivFix',\s*'civfix',\s*NULL,/)
  })

  it("conflicts on the id alone, so a handle clash fails loudly instead of skipping", () => {
    expect(migration).toContain("ON CONFLICT (id) DO NOTHING")
  })

  it("frees the handle with the placeholder shape and never starts a rename cooldown", () => {
    expect(migration).toContain("SET handle = 'user' || left(replace(id::text, '-', ''), 12)")
    expect(migration).not.toContain("handle_changed_at")
    expect(migration.slice(0, migration.indexOf("INSERT INTO users"))).not.toContain("display_name")
  })
})

describe("the official account can never hold a session", () => {
  it("refuses to mint one, in any letter case of the id", async () => {
    const { service, store } = makeSessions()

    await expect(service.createSession(CIVFIX_OFFICIAL_USER_ID, ["citizen"])).rejects.toMatchObject(
      {
        httpStatus: 403,
      },
    )
    await expect(
      service.createSession(CIVFIX_OFFICIAL_USER_ID.toUpperCase(), ["citizen"]),
    ).rejects.toMatchObject({ httpStatus: 403 })
    expect(store.count()).toBe(0)
  })

  it("still mints for everyone else", async () => {
    const { service } = makeSessions()

    const token = await service.createSession(OTHER_USER, ["citizen"])

    expect((await service.resolveSession(token))?.userId).toBe(OTHER_USER)
  })

  it("does not resolve a session row planted for it, from the store or the cache", async () => {
    const { service, store, cache } = makeSessions()
    const hash = await sha256Hex("planted-token")
    await store.insert({
      id: hash,
      userId: CIVFIX_OFFICIAL_USER_ID,
      roles: ["citizen"],
      expiresAt: new Date(NOW_MS + 60_000),
      lastSeenAt: new Date(NOW_MS),
      userAgent: null,
      ip: null,
    })

    expect(await service.resolveSessionByHash(hash)).toBeNull()

    await cache.set(
      `sess:${hash}`,
      JSON.stringify({
        userId: CIVFIX_OFFICIAL_USER_ID,
        roles: ["citizen"],
        expiresAtMs: NOW_MS + 60_000,
        createdAtMs: NOW_MS,
        epoch: 0,
        accountStatus: "active",
      }),
      60,
    )

    expect(await service.resolveSessionByHash(hash)).toBeNull()
  })
})
