import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const HERE = dirname(fileURLToPath(import.meta.url))
const PG_STORES = join(HERE, "../../src/auth/pg-stores.ts")

const SCRUBBED_USER_COLUMNS = [
  "email: null",
  "displayName: DELETED_USER_LABEL",
  "bio: null",
  "avatarUrl: null",
  "avatarMediaId: null",
  "socialLinks: null",
  "donationUrl: null",
  "lastActivityGeom: null",
  "lastActivityAt: null",
  "primaryOrganizationId: null",
]

function anonymizeSet(): string {
  const source = readFileSync(PG_STORES, "utf8")
  const start = source.indexOf(".update(users)", source.indexOf("private async runErasure"))
  expect(start, "runErasure no longer updates the users table").toBeGreaterThan(0)
  const end = source.indexOf(".where(eq(users.id, id))", start)
  expect(end, "the anonymize update is no longer shaped as .set({...}).where(...)").toBeGreaterThan(
    start,
  )
  return source.slice(start, end)
}

describe("softDeleteAndAnonymize scrubs every self-authored identity column", () => {
  const set = anonymizeSet()

  it.each(SCRUBBED_USER_COLUMNS)("clears %s", (assignment) => {
    expect(set).toContain(assignment)
  })

  it("does NOT clear a departing owner's events' donation links (the link is the host's, not the org's)", () => {
    const source = readFileSync(PG_STORES, "utf8")
    expect(source).not.toContain("UPDATE cleanups SET organization_id = NULL, donation_url = NULL")
    expect(source).toContain("UPDATE cleanups SET organization_id = NULL")
  })
})
