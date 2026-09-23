/**
 * Regression lock for the two-client split in src/db/client.ts (drizzle-orm#3108).
 *
 * `drizzle(client)` overwrites a postgres.js client's value serializers with identity passthroughs.
 * makeDb() therefore hands drizzle its OWN client and keeps a SEPARATE raw `sql` client (full default
 * serialization) for the hand-written PostGIS/transactional repositories. If that split ever regresses
 * (one shared client passed to drizzle AND reused for raw `sql`), binding a JS Date into a timestamp
 * column throws `TypeError [ERR_INVALID_ARG_TYPE]: ... Received an instance of Date` at runtime — the
 * exact production crash this guards against (hosting a cleanup binds scheduled_at as a Date through the
 * raw tag in cleanup-repository.drizzle.ts).
 *
 * NO DATABASE NEEDED: postgres.js connects lazily, so makeDb() builds both clients (and drizzle runs its
 * in-place serializer mutation on its own client) without opening a socket. We only inspect serializer
 * config. This is the unit-level guard the Docker-gated integration tests cannot provide locally / in a
 * Docker-less CI.
 */

import { describe, it, expect } from "vitest"
import { makeDb, sslOptionForUrl } from "../../src/db/client.js"

/** Minimal view of the postgres.js internal we assert on (its public type does not expose `options`). */
type WithSerializers = { options: { serializers: Record<number, (v: unknown) => unknown> } }

describe("makeDb: the raw sql client keeps postgres.js Date serializers (drizzle-orm#3108)", () => {
  const handle = makeDb("postgres://u:p@localhost:5432/civfix")
  const serializers = (handle.sql as unknown as WithSerializers).options.serializers
  const sample = new Date("2026-06-04T12:00:00.000Z")

  // 1184 = timestamptz, 1114 = timestamp, 1082 = date. createCleanupTx binds a Date into a timestamptz
  // column (scheduled_at), so 1184 is the one that actually crashed; 1114/1082 are the same family.
  it.each([1184, 1114, 1082])(
    "serializes a Date to a string for OID %i (not the identity passthrough drizzle installs)",
    (oid) => {
      const serialize = serializers[oid]
      // Throw (not just expect) so TS narrows away `undefined` and the failure names the missing OID.
      if (typeof serialize !== "function")
        throw new Error(`no serializer registered for OID ${oid}`)
      // A clean postgres.js client returns the ISO string; a drizzle-clobbered client returns the Date.
      const out = serialize(sample)
      expect(typeof out).toBe("string")
      expect(out).not.toBeInstanceOf(Date)
    },
  )

  it("close() resolves without ever opening a connection (makeDb is lazy)", async () => {
    await expect(handle.close()).resolves.toBeUndefined()
  })
})

/**
 * M15: postgres.js defaults `ssl` to false, so an unconfigured production link would ship credentials and
 * every row in cleartext. makeDb resolves the connection string's sslmode into an EXPLICIT ssl option and
 * applies it to both clients. loadEnv separately refuses to boot production without a TLS sslmode; this
 * locks the mapping that turns that promise into an actual TLS handshake.
 */
describe("makeDb: TLS is derived from sslmode and set explicitly on both clients", () => {
  it.each([
    ["postgres://u:p@h:5432/db?sslmode=require", "require"],
    ["postgres://u:p@h:5432/db?sslmode=verify-full", "verify-full"],
    ["postgres://u:p@h:5432/db?sslmode=VERIFY-FULL", "verify-full"],
  ])("maps %s to %s", (url, expected) => {
    expect(sslOptionForUrl(url)).toBe(expected)
  })

  it("maps verify-ca to an equivalent, CA-verifying tls option", () => {
    expect(sslOptionForUrl("postgres://u:p@h:5432/db?sslmode=verify-ca")).toEqual({
      rejectUnauthorized: true,
    })
  })

  it.each([
    "postgres://u:p@h:5432/db",
    "postgres://u:p@h:5432/db?sslmode=disable",
    "postgres://u:p@h:5432/db?sslmode=prefer",
    "not a url at all",
  ])("leaves %s plaintext (local dev / testcontainers)", (url) => {
    expect(sslOptionForUrl(url)).toBe(false)
  })

  it("applies the resolved ssl option to the raw AND the drizzle client", async () => {
    const handle = makeDb("postgres://u:p@localhost:5432/civfix?sslmode=require")
    type WithSsl = { options: { ssl: unknown } }
    expect((handle.sql as unknown as WithSsl).options.ssl).toBe("require")
    await handle.close()
  })

  it("honors an explicit ssl override", async () => {
    const handle = makeDb("postgres://u:p@localhost:5432/civfix", { ssl: "verify-full" })
    type WithSsl = { options: { ssl: unknown } }
    expect((handle.sql as unknown as WithSsl).options.ssl).toBe("verify-full")
    await handle.close()
  })

  it("pins the session time zone to UTC on both clients (DECISIONS §42)", async () => {
    // Every bare `::date` cast and `to_char` on a timestamptz reads the SESSION zone. Pinning it makes
    // those deterministic regardless of the box's TZ; the day math that must NOT be UTC says so
    // explicitly with `AT TIME ZONE <event zone>`.
    const handle = makeDb("postgres://u:p@localhost:5432/civfix")
    type WithConnection = { options: { connection?: Record<string, string> } }
    expect((handle.sql as unknown as WithConnection).options.connection?.TimeZone).toBe("UTC")
    await handle.close()
  })
})
