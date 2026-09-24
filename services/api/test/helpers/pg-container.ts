/**
 * The Postgres container + template-database primitives shared by the vitest globalSetup
 * (test/global-setup-pg.ts) and the per-file harness (test/helpers/pg.ts).
 *
 * The container is started ONCE by globalSetup, which applies the migrations + seed into a TEMPLATE
 * database; every test file then clones that template with `CREATE DATABASE ... TEMPLATE ...` (a
 * file-level copy inside the server, ~100ms) and gets its own fully isolated database, without paying a
 * container boot plus every migration per file.
 *
 * Nothing here imports `vitest`: globalSetup runs in a different context, where importing the `vitest`
 * entrypoint is unsupported (it reaches for per-worker state that does not exist there).
 *
 * It also owns the SKIP GUARD (pgSkipDecision / assertPgSkipAllowed): the Docker-absent skip is a
 * developer-machine affordance, and turning it into a hard failure in CI is what keeps "the whole
 * integration suite silently did not run" from passing as a green build.
 */

import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import postgres from "postgres"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import type { Sql } from "../../src/db/client.js"
import { applyMigrations } from "../../src/db/migrate.js"
import { seedJurisdictions } from "../../src/db/seed.js"

/** The PostGIS image we run. Pinned so spatial behavior is reproducible. */
const POSTGIS_IMAGE = "postgis/postgis:16-3.4"

/**
 * The migrated+seeded database every test database is cloned from. Never connected to by a test: a
 * `CREATE DATABASE ... TEMPLATE t` fails while any other session is attached to `t`.
 */
export const TEMPLATE_DB = "civfix_template"

/** Absolute path to the canonical migrations directory (services/api/drizzle), cross-platform. */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle/", import.meta.url))

/**
 * Server knobs for a THROWAWAY test database. Durability is worthless here (the container is destroyed
 * at the end of the run) and turning it off is what makes 60 migrations + ~44 template clones cheap.
 * `max_connections` is raised because the container is now shared by every vitest worker at once
 * (each test file holds a 4-connection raw pool + a 2-connection Drizzle pool).
 */
const POSTGRES_TUNING = [
  "-c",
  "fsync=off",
  "-c",
  "synchronous_commit=off",
  "-c",
  "full_page_writes=off",
  "-c",
  "max_connections=300",
]

export interface SharedPg {
  /** Connection URI of the container's default database: the maintenance connection for CREATE/DROP. */
  adminUri: string
  /** Name of the migrated template database to clone per test file. */
  templateDb: string
  /** Stop the container. Only the owner of the container (globalSetup) may call this. */
  stop(): Promise<void>
}

export type StartSharedPgResult = { ok: true; pg: SharedPg } | { ok: false; reason: string }

/** Values an environment variable uses to mean "on". Different CI providers pick different ones. */
const TRUTHY = new Set(["1", "true", "yes", "on"])

function isOn(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase())
}

export interface PgSkipDecision {
  /** May a Docker-absent run SKIP the integration suite and still report success? */
  allowed: boolean
  /** Which variable decided, for the message the caller prints or throws. */
  because: string
}

/**
 * Is a Docker-absent SKIP acceptable here?
 *
 * The skip exists for ONE reason: this repo is developed on machines with no Docker, and a developer
 * running `pnpm test` must get a green unit suite instead of 44 hard failures. In CI that same leniency
 * is a silent hole: a broken Docker socket, a pulled image or a testcontainers upgrade would make the
 * ENTIRE integration suite vanish from the run while the job still reports success. The suite is the only
 * thing that exercises the real SQL, so "green because nothing ran" must be impossible in CI.
 *
 * Resolution order (first match wins):
 *   1. CIVFIX_ALLOW_PG_SKIP: explicit escape hatch for a CI job that intentionally has no Docker.
 *   2. CIVFIX_REQUIRE_PG: explicit demand (usable locally to prove the harness really ran).
 *   3. CI: set to `true` by GitHub Actions (and by every other provider), so the guard is on in CI with
 *      no workflow change.
 *   4. otherwise: a developer machine; skipping is the whole point.
 */
export function pgSkipDecision(env: NodeJS.ProcessEnv = process.env): PgSkipDecision {
  if (isOn(env.CIVFIX_ALLOW_PG_SKIP)) {
    return { allowed: true, because: "CIVFIX_ALLOW_PG_SKIP is set" }
  }
  if (isOn(env.CIVFIX_REQUIRE_PG)) {
    return { allowed: false, because: "CIVFIX_REQUIRE_PG is set" }
  }
  if (isOn(env.CI)) {
    return { allowed: false, because: `CI=${env.CI ?? ""}` }
  }
  return { allowed: true, because: "no CI / CIVFIX_REQUIRE_PG in this environment" }
}

/**
 * Throw when a Docker-absent SKIP is not acceptable (see pgSkipDecision). Called on every path that
 * would otherwise turn "no Docker" into "no tests": the shared container's start failure and the
 * per-file harness's `unavailable` branch.
 */
export function assertPgSkipAllowed(reason: string, env: NodeJS.ProcessEnv = process.env): void {
  const decision = pgSkipDecision(env)
  if (decision.allowed) return
  throw new Error(
    `[pg harness] Postgres is REQUIRED in this environment (${decision.because}), but the PostGIS ` +
      `container could not start, which would have SILENTLY SKIPPED the whole integration suite. ` +
      `Fix Docker, or set CIVFIX_ALLOW_PG_SKIP=1 to accept a run with no integration coverage. ` +
      `Underlying failure: ${reason}`,
  )
}

/**
 * Start the container and build the migrated template database.
 *
 * Returns `{ ok: false, reason }` when Docker is unavailable (this repo is developed on machines with no
 * Docker) so callers can SKIP rather than fail, UNLESS this environment forbids that skip (CI, see
 * assertPgSkipAllowed), in which case it throws rather than let the integration suite disappear from a
 * green run. A migration/seed failure is never the skip case: it is a real error and throws, after
 * cleaning up the container.
 */
export async function startSharedPg(): Promise<StartSharedPgResult> {
  let started: StartedPostgreSqlContainer
  try {
    started = await new PostgreSqlContainer(POSTGIS_IMAGE).withCommand(POSTGRES_TUNING).start()
  } catch (err) {
    // Docker not installed / daemon not running / image unavailable: skip, do not fail, but only where
    // a skip is legitimate. In CI this throws.
    const reason = err instanceof Error ? err.message : String(err)
    assertPgSkipAllowed(reason)
    return { ok: false, reason }
  }

  const adminUri = started.getConnectionUri()
  const stop = async (): Promise<void> => {
    await started.stop().catch(() => {})
  }

  try {
    await createDatabase(adminUri, TEMPLATE_DB, null)
    const templateSql = postgres(uriWithDatabase(adminUri, TEMPLATE_DB), {
      max: 4,
      onnotice: () => {},
    })
    try {
      // Apply the EXACT canonical SQL the production runner applies, then the shared seed.
      await applyMigrations(templateSql, MIGRATIONS_DIR)
      await seedJurisdictions(templateSql)
      await applyTestFixtureDefaults(templateSql)
    } finally {
      // MUST be closed before any clone: CREATE DATABASE ... TEMPLATE refuses to run while another
      // session is connected to the source database.
      await templateSql.end({ timeout: 5 }).catch(() => {})
    }
  } catch (err) {
    await stop()
    throw err
  }

  return { ok: true, pg: { adminUri, templateDb: TEMPLATE_DB, stop } }
}

/** Rewrite a postgres:// URI to point at a different database on the same server. */
export function uriWithDatabase(uri: string, database: string): string {
  const url = new URL(uri)
  url.pathname = `/${database}`
  return url.toString()
}

/** A fresh, valid, collision-free database identifier for one test file. */
export function uniqueTestDbName(): string {
  return `civfix_t_${randomUUID().replace(/-/g, "")}`
}

/**
 * `CREATE DATABASE name [TEMPLATE template]` over a short-lived maintenance connection (CREATE DATABASE
 * cannot run inside a transaction, so this goes through `unsafe`; both identifiers are generated here,
 * never test input, and are double-quoted).
 *
 * Retries a couple of times: every vitest worker clones the SAME template concurrently, and while
 * PostgreSQL takes only a ShareLock on the source (so concurrent clones are legal), a straggling
 * connection to the template makes the clone fail with a transient "source database is being accessed by
 * other users".
 */
export async function createDatabase(
  adminUri: string,
  name: string,
  template: string | null,
): Promise<void> {
  const stmt =
    template === null
      ? `CREATE DATABASE "${name}"`
      : `CREATE DATABASE "${name}" TEMPLATE "${template}"`
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    const admin = postgres(adminUri, { max: 1, onnotice: () => {} })
    try {
      await admin.unsafe(stmt)
      return
    } catch (err) {
      lastErr = err
    } finally {
      await admin.end({ timeout: 5 }).catch(() => {})
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
  }
  throw lastErr
}

/**
 * Drop a test database, evicting any leftover session (`WITH (FORCE)`, PG13+) so a pool that was not
 * fully drained cannot wedge the drop. Best-effort: the container is destroyed at the end of the run
 * anyway, so a failure here must never fail a test.
 */
export async function dropDatabaseIfExists(adminUri: string, name: string): Promise<void> {
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  } catch {
    // ignored on purpose (see doc comment)
  } finally {
    await admin.end({ timeout: 5 }).catch(() => {})
  }
}

/**
 * Test-harness-only column defaults for two NOT-NULL columns the PRODUCTION app always supplies but
 * that raw fixture inserts here would otherwise have to hand-roll at ~30 call sites:
 *
 *   - users.handle: made NOT NULL (no default) by 0026_user_handle_required.sql. The app assigns a
 *     handle during registration; fixtures that insert a bare user don't care about it.
 *   - reports.type: 0021_report_type.sql adds it with a default 'other' then DROPS the default, so the
 *     app must send a type. Fixtures that set up a report to exercise a read query don't care about the
 *     fine type.
 *
 * These defaults change ONLY the throwaway test template (never the canonical migrations / production
 * schema) and weaken NO assertion: the suite has no test that a bare insert of these columns is rejected,
 * and every place that actually cares supplies an explicit value (which overrides the default). A fixture
 * that must pin a handle passes one; one that doesn't get a unique generated placeholder.
 */
async function applyTestFixtureDefaults(sql: Sql): Promise<void> {
  await sql`ALTER TABLE users ALTER COLUMN handle SET DEFAULT 'u' || substr(md5(random()::text), 1, 12)`
  await sql`ALTER TABLE reports ALTER COLUMN type SET DEFAULT 'other'`
}
