import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleBroadcastRepository } from "../../src/services/host/broadcast-repository.drizzle.js"
import type { BroadcastRepository } from "../../src/services/host/broadcast-repository.js"

const pg = await withPg()

describe.skipIf(!pg)("broadcast host/member identity reads (integration)", () => {
  let h: PgHarness
  let repo: BroadcastRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleBroadcastRepository(h.sql)
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(over: {
    displayName: string
    email?: string | null
    emailVerified?: boolean
    locale?: string
  }): Promise<string> {
    const handle = `u${randomUUID().replace(/-/g, "").slice(0, 15)}`
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle, email, email_verified, locale)
      VALUES (
        ${over.displayName},
        ${handle},
        ${over.email ?? null},
        ${over.emailVerified ?? false},
        ${over.locale ?? "en"}
      )
      RETURNING id`
    return row!.id
  }

  async function suspend(userId: string): Promise<void> {
    await h.sql`
      INSERT INTO user_moderation (user_id, host_messaging_suspended)
      VALUES (${userId}, true)
      ON CONFLICT (user_id) DO UPDATE SET host_messaging_suspended = true`
  }

  it("hostMessagingState runs against the real schema and reports a verified host", async () => {
    const userId = await newUser({
      displayName: "Ada Host",
      email: "ada@example.org",
      emailVerified: true,
    })
    const state = await repo.hostMessagingState(userId)
    expect(state).not.toBeNull()
    expect(state!.emailVerified).toBe(true)
    expect(state!.suspended).toBe(false)
    expect(state!.accountCreatedAt).toBeInstanceOf(Date)
  })

  it("hostMessagingState reports an UNVERIFIED host as unverified", async () => {
    const userId = await newUser({
      displayName: "Unverified Host",
      email: "nope@example.org",
      emailVerified: false,
    })
    const state = await repo.hostMessagingState(userId)
    expect(state!.emailVerified).toBe(false)
  })

  it("hostMessagingState reflects a host_messaging_suspended moderation row", async () => {
    const userId = await newUser({
      displayName: "Suspended Host",
      email: "susp@example.org",
      emailVerified: true,
    })
    await suspend(userId)
    const state = await repo.hostMessagingState(userId)
    expect(state!.suspended).toBe(true)
    expect(state!.emailVerified).toBe(true)
  })

  it("hostMessagingState is null for a soft-deleted user", async () => {
    const userId = await newUser({ displayName: "Gone", email: "gone@example.org" })
    await h.sql`UPDATE users SET deleted_at = now() WHERE id = ${userId}`
    expect(await repo.hostMessagingState(userId)).toBeNull()
  })

  it("memberContacts runs against the real schema and maps verification per user", async () => {
    const verified = await newUser({
      displayName: "Grace Hopper",
      email: "grace@example.org",
      emailVerified: true,
      locale: "es",
    })
    const unverified = await newUser({
      displayName: "Alan Turing",
      email: "alan@example.org",
      emailVerified: false,
    })
    const contacts = await repo.memberContacts([verified, unverified])
    expect(contacts.size).toBe(2)
    const g = contacts.get(verified)!
    expect(g.email).toBe("grace@example.org")
    expect(g.emailVerified).toBe(true)
    expect(g.displayName).toBe("Grace Hopper")
    expect(g.firstName).toBe("Grace")
    expect(g.locale).toBe("es")
    const a = contacts.get(unverified)!
    expect(a.emailVerified).toBe(false)
    expect(a.email).toBe("alan@example.org")
  })

  it("memberContacts omits a soft-deleted user", async () => {
    const userId = await newUser({ displayName: "Deleted Member", email: "del@example.org" })
    await h.sql`UPDATE users SET deleted_at = now() WHERE id = ${userId}`
    const contacts = await repo.memberContacts([userId])
    expect(contacts.size).toBe(0)
  })
})
