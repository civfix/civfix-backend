/**
 * Admin system-health route (Phase 2).
 *
 *   GET /admin/system/health  service-health summary (SystemHealthResponse).
 *
 * Read-only operator view (no audit written for a read). The requireOperator guard is applied by
 * routes/admin/index.ts. This route WIRES the real dependency probes from the container into the
 * SystemHealthService (which assembles the panel + degrades gracefully on any single probe failure). The
 * probes are guarded so the offline / all-fakes boot never tries to open a connection that does not exist:
 *   - Postgres / Redis probes are only built when DATABASE_URL / REDIS_URL are configured;
 *   - the media-worker (pg-boss) probe reports 'not_deployed' when the pgboss schema is absent rather than
 *     a false 'down';
 *   - the OCI Email probe counts recent mail_events (deliverability signal).
 * Tests inject a SystemHealthService via the override so no live infra is needed.
 */

import type { SystemHealthResponse } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import {
  makeSystemHealthService,
  MEDIA_WORKER_BACKLOG_WARN,
  type ProbeResult,
  type SystemHealthProbes,
  type SystemHealthService,
} from "../../services/admin/system-health-service.js"
import { route } from "../../versioning/route.js"

/**
 * Optional injected system-health service (tests). When present the route uses it directly instead of
 * assembling one from the container, so the whole HTTP flow runs offline with no DB / Redis / pg-boss.
 */
export interface SystemRouteOverrides {
  service: SystemHealthService
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected system-route override (tests). See SystemRouteOverrides. */
    systemOverrides?: SystemRouteOverrides
  }
}

/** Postgres SQLSTATE for "undefined_table" (the pgboss schema not provisioned yet). */
const PG_UNDEFINED_TABLE = "42P01"

export async function registerAdminSystemRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the system-health service from an injected override (tests) or the container (production). */
  function service(): SystemHealthService {
    const override = app.systemOverrides
    if (override) return override.service

    const env = container.env
    const hasDb = typeof env.DATABASE_URL === "string" && env.DATABASE_URL.length > 0
    const hasRedis = typeof env.REDIS_URL === "string" && env.REDIS_URL.length > 0

    const probes: SystemHealthProbes = {}

    if (hasDb) {
      probes.postgres = async (): Promise<ProbeResult> => {
        const sql = container.getDb().sql
        const rows = await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM jurisdictions`
        return { val: `${rows[0]?.n ?? "0"} jurisdictions`, status: "ok" }
      }
      probes.ociEmail = async (): Promise<ProbeResult> => {
        const sql = container.getDb().sql
        const rows = await sql<{ n: string }[]>`
          SELECT COUNT(*)::text AS n
          FROM mail_events
          WHERE created_at >= now() - make_interval(days => 7)
        `
        const n = Number.parseInt(rows[0]?.n ?? "0", 10)
        return { val: `${Number.isNaN(n) ? 0 : n} events 7d`, status: "ok" }
      }
      // Media-worker depth from pg-boss. A missing pgboss schema -> 'not_deployed' (not yet wired), other
      // errors bubble to the service's catch -> 'down'.
      probes.mediaWorker = async (): Promise<ProbeResult> => {
        const sql = container.getDb().sql
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
      }
    }

    if (hasRedis) {
      probes.redis = async (): Promise<ProbeResult> => {
        const pong = await container.getRedis().ping()
        return { val: pong, status: "ok" }
      }
    }

    return makeSystemHealthService({
      probes,
      env: {
        glitchTipConfigured:
          typeof env.GLITCHTIP_DSN === "string" && env.GLITCHTIP_DSN.length > 0,
        // The clients hardcode the CARTO Voyager raster basemap, so a tile source is always advertised.
        tileCdnConfigured: true,
        mailerIsFake: env.USE_FAKE_MAILER,
        jobsIsFake: env.USE_FAKE_JOBS,
      },
    })
  }

  // -------------------------------------------------------------------------
  // GET /admin/system/health
  // -------------------------------------------------------------------------
  route(app, "adminSystemHealth", async (_request, reply) => {
    const payload: SystemHealthResponse = await service().health()
    reply.status(200).send(payload)
  })
}

/** Is this a Postgres "undefined_table" error (the pgboss schema not provisioned)? */
function isUndefinedTable(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNDEFINED_TABLE
  )
}
