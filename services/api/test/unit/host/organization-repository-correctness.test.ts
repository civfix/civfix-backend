import { describe, expect, it } from "vitest"
import { makeDrizzleOrganizationRepository } from "../../../src/services/host/organization-repository.drizzle.js"
import { InMemoryOrganizationRepository } from "../../../src/services/host/organization-repository.memory.js"
import { makeFakeSql } from "../../helpers/fake-sql.js"
import type { Sql } from "../../../src/db/client.js"

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const MEMBER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const NOW = new Date("2026-01-01T12:00:00.000Z")

function uniqueViolation(constraint: string): Error {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint_name: constraint,
  })
}

function createArgs() {
  return {
    organizationId: ORG,
    slug: "adopt-a-block",
    name: "Adopt-a-Block",
    description: null,
    websiteUrl: null,
    logoMediaId: null,
    socialLinks: null,
    createdBy: OWNER,
    now: NOW,
  }
}

describe("creating an organization", () => {
  it("answers slug_taken only for the slug index", async () => {
    const fake = makeFakeSql([
      {
        match: /INSERT INTO organizations\s*\(/,
        rows: () => {
          throw uniqueViolation("organizations_slug_uidx")
        },
      },
    ])

    await expect(
      makeDrizzleOrganizationRepository(fake.sql as unknown as Sql).createOrganizationTx(
        createArgs(),
      ),
    ).resolves.toBe("slug_taken")
  })

  it("surfaces any other unique violation instead of calling it a taken slug", async () => {
    const fake = makeFakeSql([
      {
        match: /INSERT INTO organization_members/,
        rows: () => {
          throw uniqueViolation("organization_members_one_owner_uidx")
        },
      },
    ])

    await expect(
      makeDrizzleOrganizationRepository(fake.sql as unknown as Sql).createOrganizationTx(
        createArgs(),
      ),
    ).rejects.toMatchObject({ constraint_name: "organization_members_one_owner_uidx" })
  })
})

describe("seating a member by handle", () => {
  it("is audited as a member added, not a role change", async () => {
    const fake = makeFakeSql([
      { match: /INSERT INTO organization_members/, rows: [{ user_id: MEMBER }] },
      { match: /INSERT INTO audit_log/, rows: [{ id: "audit-1" }] },
    ])

    await makeDrizzleOrganizationRepository(fake.sql as unknown as Sql).addMemberTx({
      organizationId: ORG,
      userId: MEMBER,
      role: "member",
      actorId: OWNER,
      now: NOW,
    })

    const audit = fake.statements.find((s) => s.values.includes("org.member_added"))
    expect(audit).toBeDefined()
    expect(fake.statements.some((s) => s.values.includes("org.member_role_changed"))).toBe(false)
  })

  it("is audited the same way by the in-memory repository", async () => {
    const repo = new InMemoryOrganizationRepository()

    await repo.addMemberTx({
      organizationId: ORG,
      userId: MEMBER,
      role: "member",
      actorId: OWNER,
      now: NOW,
    })

    expect(repo.audits.map((a) => a.action)).toEqual(["org.member_added"])
  })
})
