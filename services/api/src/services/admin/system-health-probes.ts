/**
 * The real dependency probes for the admin system-health panel, kept OUT of the route file (route -> DB
 * layer fix). Each probe is a small bounded query; the route wires it into the SystemHealthService, which
 * runs them under its own try/catch and renders a failure as a 'down' row.
 *
 * Every probe is wrapped in a hard timeout: a hung Postgres/Redis connection must surface as a quick
 * 'down' (the probe rejects) rather than hanging the whole /admin/system/health request until the server
 * request timeout.
 */

import type { Sql } from "../../db/client.js"
import type { ProbeResult, SystemHealthProbes } from "./system-health-service.js"
import { MEDIA_WORKER_BACKLOG_WARN } from "./system-health-service.js"

/** Per-probe wall-clock budget; a slower dependency is reported 'down'. */
export const PROBE_TIMEOUT_MS = 2000

/** Postgres SQLSTATE for "undefined_table" (the pgboss schema not provisioned yet). */
const PG_UNDEFINED_TABLE = "42P01"

function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    run(),
    new Promise<T>((_resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms)
      // Don't keep the event loop alive solely for this timer.
      if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref()
    }),
  ])
}

function isUndefinedTable(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNDEFINED_TABLE
  )
}

export interface SystemProbeDeps {
  /** Present only when DATABASE_URL is configured (offline-boot safe). */
  getSql?: () => Sql
  /** Present only when REDIS_URL is configured; resolves the PING reply (e.g. "PONG"). */
  redisPing?: () => Promise<string>
}

/** Build the wired probe set; absent getters leave that probe undefined (the service renders a fallback). */
export function makeSystemHealthProbes(deps: SystemProbeDeps): SystemHealthProbes {
  const probes: SystemHealthProbes = {}

  if (deps.getSql) {
    const getSql = deps.getSql
    const sql = getSql()
    probes.postgres = (): Promise<ProbeResult> =>
      withTimeout(async () => {
        const rows = await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM jurisdictions`
        return { val: `${rows[0]?.n ?? "0"} jurisdictions`, status: "ok" }
      }, PROBE_TIMEOUT_MS)

    probes.ociEmail = (): Promise<ProbeResult> =>
      withTimeout(async () => {
        const rows = await sql<{ n: string }[]>`
          SELECT COUNT(*)::text AS n
          FROM mail_events
          WHERE created_at >= now() - make_interval(days => 7)
        `
        const n = Number.parseInt(rows[0]?.n ?? "0", 10)
        return { val: `${Number.isNaN(n) ? 0 : n} events 7d`, status: "ok" }
      }, PROBE_TIMEOUT_MS)

    // A missing pgboss schema -> 'not_deployed' (not yet wired); other errors bubble to the service catch.
    probes.mediaWorker = (): Promise<ProbeResult> =>
      withTimeout(async () => {
        try {
          const rows = await sql<{ n: string }[]>`
            SELECT COUNT(*)::text AS n
            FROM pgboss.job
            WHERE state IN ('created', 'active', 'retry')
          `
          const depth = Number.parseInt(rows[0]?.n ?? "0", 10)
          const value = Number.isNaN(depth) ? 0 : depth
          return {
            val: `depth ${value}`,
            status: value > MEDIA_WORKER_BACKLOG_WARN ? "warn" : "ok",
          }
        } catch (err) {
          if (isUndefinedTable(err)) {
            return { val: "Queue not provisioned", status: "not_deployed" }
          }
          throw err
        }
      }, PROBE_TIMEOUT_MS)
  }

  if (deps.redisPing) {
    const redisPing = deps.redisPing
    probes.redis = (): Promise<ProbeResult> =>
      withTimeout(async () => {
        const pong = await redisPing()
        return { val: pong, status: "ok" }
      }, PROBE_TIMEOUT_MS)
  }

  return probes
}
