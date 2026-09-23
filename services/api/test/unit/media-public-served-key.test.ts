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
import { makeDrizzleHostRegistrationRepository } from "../../src/services/host/registration-repository.drizzle.js"
import { publicServedKeyExpr } from "../../src/services/media-served-key.js"
import { makeDrizzleSocialRepository } from "../../src/services/social-repository.drizzle.js"
import { makeFakeSql, type FakeSqlControl } from "../helpers/fake-sql.js"

const ID = "11111111-1111-4111-8111-111111111111"
const SRC = fileURLToPath(new URL("../../src/", import.meta.url))

const UPLOADED_ORIGINAL_COLUMN = /\.r2_key\b/

const OWNER_GATED_SERVED_KEY_READERS = ["services/report-repository.drizzle.ts"]

const RAW_UPLOAD_KEY_IN_SQL = /[\w}]\.r2_key\b/

const RAW_UPLOAD_KEY_READERS: Record<string, string> = {
  "services/media-served-key.ts": "defines the uploader, moderation and public key expressions",
  "services/avatar-media.ts":
    "the avatar claim answers only the claimant, and binds the served copy",
  "services/media-worker-repo.ts": "the media worker reads the original to re-encode it",
  "services/certificate-repository.drizzle.ts":
    "service_hours_certificates.r2_key is a generated certificate, not an upload",
  "services/report-sql.ts":
    "m is the ready-only firstReadyStillLateral, whose r2_key is served_key",
  "services/cleanup-repository.drizzle.ts":
    "m is the ready-only firstReadyStillLateral, whose r2_key is served_key",
  "services/post-repository.drizzle.ts":
    "m is the ready-only firstReadyStillLateral, whose r2_key is served_key",
}

const SQL_TAG_LOOKBEHIND_CHARS = 1000

const SQL_TAG_BEFORE_TEMPLATE = /\b(?:sql|tx|tag|q)\s*(?:<[\s\S]*>)?$/

function sqlOf(fake: FakeSqlControl): string {
  return fake.statements.map((s) => s.sql.replace(/\s+/g, " ")).join("\n")
}

function quotedEnd(code: string, start: number): number {
  const quote = code[start]
  let i = start + 1
  while (i < code.length && code[i] !== quote && code[i] !== "\n") {
    i += code[i] === "\\" ? 2 : 1
  }
  return i + 1
}

function interpolationEnd(code: string, start: number): number {
  let depth = 1
  let i = start
  while (i < code.length && depth > 0) {
    const c = code[i]
    if (c === "`") {
      i = templateEnd(code, i + 1) + 1
      continue
    }
    if (c === "'" || c === '"') {
      i = quotedEnd(code, i)
      continue
    }
    if (c === "{") depth++
    if (c === "}") depth--
    i++
  }
  return i
}

function templateEnd(code: string, start: number): number {
  let i = start
  while (i < code.length) {
    const c = code[i]
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === "`") return i
    if (c === "$" && code[i + 1] === "{") {
      i = interpolationEnd(code, i + 2)
      continue
    }
    i++
  }
  return code.length
}

function sqlTemplateBodies(code: string): string[] {
  const bodies: string[] = []
  let i = 0
  while (i < code.length) {
    const c = code[i]
    const next = code[i + 1]
    if (c === "/" && next === "/") {
      const lineEnd = code.indexOf("\n", i)
      i = lineEnd < 0 ? code.length : lineEnd
      continue
    }
    if (c === "/" && next === "*") {
      const commentEnd = code.indexOf("*/", i + 2)
      i = commentEnd < 0 ? code.length : commentEnd + 2
      continue
    }
    if (c === "'" || c === '"') {
      i = quotedEnd(code, i)
      continue
    }
    if (c === "`") {
      const end = templateEnd(code, i + 1)
      if (SQL_TAG_BEFORE_TEMPLATE.test(code.slice(Math.max(0, i - SQL_TAG_LOOKBEHIND_CHARS), i))) {
        bodies.push(code.slice(i + 1, end))
      }
      i = end + 1
      continue
    }
    i++
  }
  return bodies
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
      "an event page's cover",
      (fake) => makeDrizzleHostRegistrationRepository(fake.sql as unknown as Sql).getPage(ID),
    ],
    [
      "a public event page's cover and organization logo",
      (fake) =>
        makeDrizzleHostRegistrationRepository(fake.sql as unknown as Sql).getPublicPage("slug"),
    ],
    [
      "an event page's block images",
      (fake) =>
        makeDrizzleHostRegistrationRepository(fake.sql as unknown as Sql).mediaKeysFor(ID, [ID]),
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

  it("never selects an uploaded original outside the readers allowed to", () => {
    const readers = sourceFiles(SRC)
      .filter((path) =>
        sqlTemplateBodies(readFileSync(path, "utf8")).some((body) =>
          RAW_UPLOAD_KEY_IN_SQL.test(body),
        ),
      )
      .map((path) => relative(SRC, path).split("\\").join("/"))
      .sort()

    expect(readers).toEqual(Object.keys(RAW_UPLOAD_KEY_READERS).sort())
  })
})
