import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { seedOfficialAccount } from "../helpers/official-account.js"
import { CIVFIX_OFFICIAL_USER_ID } from "../../src/auth/official-account.js"
import { generatePlaceholderHandle } from "../../src/auth/stores.js"
import { makeDrizzleSocialRepository } from "../../src/services/social-repository.drizzle.js"

const pg = await withPg()

interface OfficialRow {
  handle: string
  display_name: string
  handle_changed_at: Date | null
  email: string | null
  role: string
  bio: string | null
  profile_complete: boolean
  allow_direct_messages: boolean
}

describe.skipIf(!pg)("0180 official account (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function userRow(id: string): Promise<OfficialRow | undefined> {
    const rows = await h.sql<OfficialRow[]>`
      SELECT handle, display_name, handle_changed_at, email, role, bio, profile_complete, allow_direct_messages
      FROM users WHERE id = ${id}
    `
    return rows[0]
  }

  it("leaves the migrated database holding the official row: no email, DMs closed", async () => {
    expect(await userRow(CIVFIX_OFFICIAL_USER_ID)).toEqual({
      handle: "civfix",
      display_name: "CivFix",
      handle_changed_at: null,
      email: null,
      role: "citizen",
      bio: "The official CivFix account.",
      profile_complete: true,
      allow_direct_messages: false,
    })
  })

  it("never offers the official account as a follow suggestion", async () => {
    const [viewer] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES ('Viewer', ${testHandle()}) RETURNING id
    `
    const suggested = await makeDrizzleSocialRepository(h.sql).suggestFollows({
      viewerId: viewer!.id,
      limit: 50,
    })

    expect(suggested.map((p) => p.id)).not.toContain(CIVFIX_OFFICIAL_USER_ID)
  })

  it("takes @civfix from a prior holder by renaming only its handle, and re-applies as a no-op", async () => {
    await h.sql`DELETE FROM users WHERE id = ${CIVFIX_OFFICIAL_USER_ID}`
    const [holder] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle, email)
      VALUES ('civfix', 'CivFix', ${`${testHandle()}@example.test`})
      RETURNING id
    `

    await seedOfficialAccount(h.sql)
    await seedOfficialAccount(h.sql)

    const prior = await userRow(holder!.id)
    expect(prior?.handle).toBe(generatePlaceholderHandle(holder!.id))
    expect(prior?.display_name).toBe("civfix")
    expect(prior?.handle_changed_at).toBeNull()
    expect((await userRow(CIVFIX_OFFICIAL_USER_ID))?.handle).toBe("civfix")
  })
})
