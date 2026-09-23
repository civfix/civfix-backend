import type { Sql } from "../../db/client.js"
import type { ProbeResult, SystemHealthProbes } from "./system-health-service.js"
import { MEDIA_WORKER_BACKLOG_WARN } from "./system-health-service.js"

export const PROBE_TIMEOUT_MS = 2000

const PG_UNDEFINED_TABLE = "42P01"

/**
 * LIKE pattern for the media worker's pg-boss queues (today: "media.checks"). The depth probe used to count
 * EVERY queue's pending jobs, so an outreach-digest or inbound-sweep backlog warned on the "Media worker"
 * tile.
 */
const MEDIA_QUEUE_LIKE = "media.%"

function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    run(),
    new Promise<T>((_resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms)
      if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref()
    }),
  ])
}

function withQueryTimeout<T>(
  query: PromiseLike<T> & { cancel: () => void },
  ms: number,
): Promise<T> {
  return Promise.race([
    query,
    new Promise<T>((_resolve, reject) => {
      const t = setTimeout(() => {
        query.cancel()
        reject(new Error(`probe timed out after ${ms}ms`))
      }, ms)
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
  getSql?: () => Sql
  redisPing?: () => Promise<string>
}

export function makeSystemHealthProbes(deps: SystemProbeDeps): SystemHealthProbes {
  const probes: SystemHealthProbes = {}

  if (deps.getSql) {
    // Resolved INSIDE each probe: `getSql` is a lazy seam (the DB handle may not exist when the probes are
    // constructed), and calling it here defeated that.
    const getSql = deps.getSql
    probes.postgres = async (): Promise<ProbeResult> => {
      const sql = getSql()
      const rows = await withQueryTimeout(
        sql<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM jurisdictions`,
        PROBE_TIMEOUT_MS,
      )
      return { val: `${rows[0]?.n ?? "0"} jurisdictions`, status: "ok" }
    }

    probes.ociEmail = async (): Promise<ProbeResult> => {
      const sql = getSql()
      const rows = await withQueryTimeout(
        sql<{ n: string }[]>`
          SELECT COUNT(*)::text AS n
          FROM mail_events
          WHERE created_at >= now() - make_interval(days => 7)
        `,
        PROBE_TIMEOUT_MS,
      )
      const n = Number.parseInt(rows[0]?.n ?? "0", 10)
      return { val: `${Number.isNaN(n) ? 0 : n} events 7d`, status: "ok" }
    }

    probes.mediaWorker = async (): Promise<ProbeResult> => {
      const sql = getSql()
      try {
        const rows = await withQueryTimeout(
          sql<{ n: string }[]>`
            SELECT COUNT(*)::text AS n
            FROM pgboss.job
            WHERE state IN ('created', 'active', 'retry')
              AND name LIKE ${MEDIA_QUEUE_LIKE}
          `,
          PROBE_TIMEOUT_MS,
        )
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
    }
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
