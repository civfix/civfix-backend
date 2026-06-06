/**
 * Admin system-health service (Phase 2): the operator service-health panel (#7, enumeration 2.J + 4.10).
 *
 * Returns one row per service ({ name, status, val }) derived HONESTLY and DEGRADING GRACEFULLY: a single
 * unreachable dependency downgrades only its own row (status 'warn'/'down'), it NEVER throws / 500s the
 * whole panel. Reconciliation (decisions 8): "Video transcoder" -> media worker (a pg-boss queue-depth
 * stat), the VRP / Valhalla router is Phase 3 -> 'not_deployed'. The probed surfaces:
 *
 *   API          always 'ok' (this handler is responding, so the API is up).
 *   Postgres     reachable + a simple stat (a row count) -> ok | down.
 *   Redis        reachable via PING -> ok | down.
 *   Media worker pg-boss queue depth (pending + active jobs) -> ok | warn (deep backlog). When jobs are
 *                faked / not wired -> 'not_deployed'.
 *   OCI Email    recent mail_events presence + (when faked) 'warn' that it is a fake relay.
 *   GlitchTip    configured (GLITCHTIP_DSN set) -> ok, else 'warn' (errors not tracked).
 *   Tile CDN     a raster basemap source is advertised (always, since the clients hardcode CARTO) -> ok.
 *   Routing/VRP  Phase 3 -> 'not_deployed'.
 *
 * The probes are INJECTED (SystemHealthProbes) so the assembly + the degrade-on-failure logic is
 * unit-testable with no DB / Redis / pg-boss; the route wires the real probes from the container. Each
 * probe is run inside a try/catch by this service (probeOk), so a probe that THROWS becomes a 'down' row
 * rather than failing the response.
 */

import type { SystemHealthResponse, SystemService } from "@civfix/shared"

/** A health status (mirrors the shared SystemService.status union). */
export type HealthStatus = "ok" | "warn" | "down" | "not_deployed"

/** The result of a single dependency probe: a value string + (optionally) an explicit status. */
export interface ProbeResult {
  /** Short metric/value string shown next to the service (e.g. "142 rows", "PONG", "depth 3"). */
  val: string
  /** Explicit status; when omitted the caller treats a returned result as 'ok'. */
  status?: HealthStatus
}

/**
 * The injectable dependency probes. Each is OPTIONAL: an absent probe means "this dependency is not wired
 * in this environment" and the service reports a sensible fallback ('not_deployed' for the media worker,
 * a configured/unconfigured status for the static ones). A probe that REJECTS is caught by the service
 * and rendered as a 'down' row (the dependency is unreachable).
 */
export interface SystemHealthProbes {
  /** Probe Postgres (e.g. SELECT a small count). Resolve with a stat; reject if unreachable. */
  postgres?: () => Promise<ProbeResult>
  /** Probe Redis (e.g. PING). Resolve with a stat; reject if unreachable. */
  redis?: () => Promise<ProbeResult>
  /** Probe the media-worker queue (pg-boss depth). Resolve with a depth stat; reject if unreachable. */
  mediaWorker?: () => Promise<ProbeResult>
  /** Probe recent mail delivery (mail_events count in a window). Resolve with a stat; reject on error. */
  ociEmail?: () => Promise<ProbeResult>
}

/** The static environment facts the service needs (no IO). */
export interface SystemHealthEnv {
  /** GLITCHTIP_DSN configured -> error tracking is on. */
  glitchTipConfigured: boolean
  /** A tile basemap source is advertised (the clients always have the CARTO raster default). */
  tileCdnConfigured: boolean
  /** Mailer is the fake (no real OCI relay) -> the OCI Email row is a 'warn' even if it "works". */
  mailerIsFake: boolean
  /** Jobs is the fake (no real pg-boss) -> the media-worker row is 'not_deployed'. */
  jobsIsFake: boolean
}

export interface SystemHealthServiceDeps {
  probes: SystemHealthProbes
  env: SystemHealthEnv
}

export interface SystemHealthService {
  health(): Promise<SystemHealthResponse>
}

/** A pg-boss queue depth past which the media-worker row degrades to 'warn' (a backlog is building). */
export const MEDIA_WORKER_BACKLOG_WARN = 50

/**
 * Run a probe inside a guard: a resolved result keeps its status (default 'ok'); a rejected/throwing
 * probe becomes a 'down' row with a short reason. An ABSENT probe yields the supplied fallback row.
 */
async function probeRow(
  name: string,
  probe: (() => Promise<ProbeResult>) | undefined,
  fallback: { status: HealthStatus; val: string },
): Promise<SystemService> {
  if (!probe) return { name, status: fallback.status, val: fallback.val }
  try {
    const result = await probe()
    return { name, status: result.status ?? "ok", val: result.val }
  } catch (err) {
    return { name, status: "down", val: shortReason(err) }
  }
}

/** A short, single-line reason string from a thrown error (for the 'down' val). */
function shortReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const firstLine = msg.split("\n")[0] ?? msg
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine
}

export function makeSystemHealthService(deps: SystemHealthServiceDeps): SystemHealthService {
  const { probes, env } = deps
  return {
    async health(): Promise<SystemHealthResponse> {
      // API is up by definition (this code is running). Everything else is probed independently so one
      // failure never sinks the panel.
      const api: SystemService = { name: "API", status: "ok", val: "Responding" }

      const [postgres, redis, mediaWorker, ociEmail] = await Promise.all([
        probeRow("Postgres", probes.postgres, { status: "down", val: "No probe" }),
        probeRow("Redis", probes.redis, { status: "down", val: "No probe" }),
        // Media worker (renamed from the design's "Video transcoder"): when jobs is the fake there is no
        // real pg-boss queue, so it is 'not_deployed' here rather than a false 'down'.
        probeRow("Media worker", env.jobsIsFake ? undefined : probes.mediaWorker, {
          status: "not_deployed",
          val: "Jobs queue not wired",
        }),
        probeRow("OCI Email", probes.ociEmail, { status: "down", val: "No probe" }),
      ])

      // The OCI Email row, when reachable but using the FAKE mailer, is a 'warn' (mail is not really being
      // relayed). A genuine probe failure already made it 'down' above.
      const ociEmailRow: SystemService =
        env.mailerIsFake && ociEmail.status === "ok"
          ? { name: "OCI Email", status: "warn", val: `${ociEmail.val} (fake relay)` }
          : ociEmail

      const glitchTip: SystemService = env.glitchTipConfigured
        ? { name: "GlitchTip", status: "ok", val: "Tracking errors" }
        : { name: "GlitchTip", status: "warn", val: "Not configured" }

      const tileCdn: SystemService = env.tileCdnConfigured
        ? { name: "Tile CDN", status: "ok", val: "CARTO raster" }
        : { name: "Tile CDN", status: "warn", val: "No basemap source" }

      // Routing / VRP (the design's "Valhalla routing") is a Phase 3 fast-follow; never reported as down.
      const routing: SystemService = {
        name: "Routing (VRP)",
        status: "not_deployed",
        val: "Phase 3",
      }

      return {
        services: [
          api,
          postgres,
          redis,
          mediaWorker,
          ociEmailRow,
          glitchTip,
          tileCdn,
          routing,
        ],
      }
    },
  }
}
