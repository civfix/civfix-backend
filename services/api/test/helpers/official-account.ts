import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Queryable } from "../../src/db/client.js"

const OFFICIAL_ACCOUNT_MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "drizzle",
  "0180_civfix_official_account.sql",
)

export function officialAccountMigrationSql(): string {
  return readFileSync(OFFICIAL_ACCOUNT_MIGRATION, "utf8")
}

export async function seedOfficialAccount(sql: Queryable): Promise<void> {
  await sql.unsafe(officialAccountMigrationSql())
}
