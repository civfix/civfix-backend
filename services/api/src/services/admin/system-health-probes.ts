import type { Sql } from "../../db/client.js"
import type { ProbeResult, SystemHealthProbes } from "./system-health-service.js"
import { MEDIA_WORKER_BACKLOG_WARN } from "./system-health-service.js"
import { PG_UNDEFINED_TABLE } from "../../db/pg-errors.js"
import { makeDrizzleSystemHealthRepository } from "./system-health-repository.drizzle.js"

const PROBE_TIMEOUT_MS = 2000

/**
 * Only the media worker's pg-boss queues, so another queue's backlog (outreach digest, inbound sweep)
 * never warns on the "Media worker" tile.
 */
const MEDIA_QUEUE_LIKE = "media.%"

// The timer is unref'd so a hung probe never holds the process open on shutdown.
function timeoutAfter<T>(ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    const t = setTimeout(() => {
      onTimeout?.()
      reject(new Error(`probe timed out after ${ms}ms`))
    }, ms)
    if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref()
  })
}

function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  return Promise.race([run(), timeoutAfter<T>(ms)])
}

function withQueryTimeout<T>(
  query: PromiseLike<T> & { cancel: () => void },
  ms: number,
): Promise<T> {
  return Promise.race([query, timeoutAfter<T>(ms, () => query.cancel())])
}

function countOf(rows: readonly { n: string }[]): number {
  const n = Number.parseInt(rows[0]?.n ?? "0", 10)
  return Number.isNaN(n) ? 0 : n
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
    // `getSql` is a lazy seam (the DB handle may not exist when the probes are constructed), so it is
    // resolved inside each probe.
    const getSql = deps.getSql
    probes.postgres = async (): Promise<ProbeResult> => {
      const repo = makeDrizzleSystemHealthRepository(getSql())
      const rows = await withQueryTimeout(repo.countJurisdictions(), PROBE_TIMEOUT_MS)
      return { val: `${rows[0]?.n ?? "0"} jurisdictions`, status: "ok" }
    }

    probes.ociEmail = async (): Promise<ProbeResult> => {
      const repo = makeDrizzleSystemHealthRepository(getSql())
      const rows = await withQueryTimeout(repo.countMailEventsLast7Days(), PROBE_TIMEOUT_MS)
      return { val: `${countOf(rows)} events 7d`, status: "ok" }
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
        const depth = countOf(rows)
        return {
          val: `depth ${depth}`,
          status: depth > MEDIA_WORKER_BACKLOG_WARN ? "warn" : "ok",
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
