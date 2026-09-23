import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { Queryable, Sql } from "../../src/db/client.js"
import { loadPrimaryAffiliations } from "../../src/services/affiliation.js"
import { makeChatGroupRepository } from "../../src/services/chat-group-repository.drizzle.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { makeDrizzleAnnouncementIdentityRepository } from "../../src/services/host/announcement-repository.drizzle.js"
import { makeDrizzleOrganizationRepository } from "../../src/services/host/organization-repository.drizzle.js"
import { publicServedKeyExpr } from "../../src/services/media-served-key.js"
import { makeDrizzleSocialRepository } from "../../src/services/social-repository.drizzle.js"
import { makeFakeSql, type FakeSqlControl } from "../helpers/fake-sql.js"

const ID = "11111111-1111-4111-8111-111111111111"
const SRC = fileURLToPath(new URL("../../src/", import.meta.url))

const UPLOADED_ORIGINAL_COLUMN = /\.r2_key\b/

const OWNER_GATED_SERVED_KEY_READERS = [
  "services/message-attachments.drizzle.ts",
  "services/report-repository.drizzle.ts",
]

function sqlOf(fake: FakeSqlControl): string {
  return fake.statements.map((s) => s.sql.replace(/\s+/g, " ")).join("\n")
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith(".ts") ? [path] : []
  })
}

describe("publicServedKeyExpr", () => {
  it("resolves only a ready asset's served copy, never the uploaded original", async () => {
    const fake = makeFakeSql()
    await fake.sql`${publicServedKeyExpr(fake.sql as unknown as Queryable, "ma")}`

    const text = sqlOf(fake)
    expect(text).toContain("status = 'ready'")
    expect(text).toContain("served_key")
    expect(text).not.toMatch(UPLOADED_ORIGINAL_COLUMN)
    expect(text).not.toContain("validating")
  })
})

describe("media read by people other than the uploader", () => {
  const reads: [string, (fake: FakeSqlControl) => Promise<unknown>][] = [
    [
      "an event's cover and host organization logo",
      (fake) => makeDrizzleCleanupRepository(fake.sql as unknown as Sql).findCleanupById(ID, null),
    ],
    [
      "an event's gallery",
      (fake) => makeDrizzleCleanupRepository(fake.sql as unknown as Sql).galleryKeysFor(ID),
    ],
    [
      "an event's organization card",
      (fake) => makeDrizzleCleanupRepository(fake.sql as unknown as Sql).loadOrganizationRef(ID),
    ],
    [
      "an organization profile",
      (fake) =>
        makeDrizzleOrganizationRepository(fake.sql as unknown as Sql).findOrganizationById(
          ID,
          null,
        ),
    ],
    [
      "a person's profile avatar",
      (fake) => makeDrizzleSocialRepository(fake.sql as unknown as Sql).findPersonById(ID),
    ],
    [
      "a chat group's avatar",
      (fake) => makeChatGroupRepository(fake.sql as unknown as Sql).findById(ID),
    ],
    [
      "an announcement author's avatar",
      (fake) =>
        makeDrizzleAnnouncementIdentityRepository(fake.sql as unknown as Sql, () =>
          Promise.resolve("u"),
        ).authorsFor([ID]),
    ],
    [
      "an affiliation badge logo",
      (fake) =>
        loadPrimaryAffiliations(fake.sql as unknown as Sql, () => Promise.resolve("u"), [ID], null),
    ],
  ]

  it.each(reads)("%s resolves only a ready served copy", async (_label, read) => {
    const fake = makeFakeSql()

    await read(fake)

    const text = sqlOf(fake)
    expect(text).toContain("served_key")
    expect(text).not.toMatch(UPLOADED_ORIGINAL_COLUMN)
  })

  it("keeps the validating fallback to the owner-gated, privately presigned readers", () => {
    const importers = sourceFiles(SRC)
      .filter((path) => /\bservedKeyExpr\b/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path).split("\\").join("/"))
      .filter((path) => path !== "services/media-served-key.ts")
      .sort()

    expect(importers).toEqual(OWNER_GATED_SERVED_KEY_READERS)
  })
})
