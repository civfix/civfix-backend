import type { SystemHealthResponse, SystemService } from "@civfix/shared"

export type HealthStatus = "ok" | "warn" | "down" | "not_deployed"

export interface ProbeResult {
  val: string
  status?: HealthStatus
}

export interface SystemHealthProbes {
  postgres?: () => Promise<ProbeResult>
  redis?: () => Promise<ProbeResult>
  mediaWorker?: () => Promise<ProbeResult>
  ociEmail?: () => Promise<ProbeResult>
}

export interface SystemHealthEnv {
  glitchTipConfigured: boolean
  tileCdnConfigured: boolean
  mailerIsFake: boolean
  jobsIsFake: boolean
}

export interface SystemHealthServiceDeps {
  probes: SystemHealthProbes
  env: SystemHealthEnv
  log?: (err: unknown, meta: { probe: string }) => void
}

export interface SystemHealthService {
  health(): Promise<SystemHealthResponse>
}

export const MEDIA_WORKER_BACKLOG_WARN = 50

export const PG_UNDEFINED_TABLE = "42P01"

const PG_INVALID_PASSWORD = "28P01"

const PG_INVALID_AUTHORIZATION = "28000"

const PG_INVALID_CATALOG_NAME = "3D000"

const NO_PROBE: { status: HealthStatus; val: string } = { status: "down", val: "No probe" }

const ROUTING_NOT_DEPLOYED_VAL = "Phase 3"

async function probeRow(
  name: string,
  probe: (() => Promise<ProbeResult>) | undefined,
  fallback: { status: HealthStatus; val: string },
  log?: (err: unknown, meta: { probe: string }) => void,
): Promise<SystemService> {
  if (!probe) return { name, status: fallback.status, val: fallback.val }
  try {
    const result = await probe()
    return { name, status: result.status ?? "ok", val: result.val }
  } catch (err) {
    log?.(err, { probe: name })
    return { name, status: "down", val: classifyProbeError(err) }
  }
}

function classifyProbeError(err: unknown): string {
  const code =
    typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes("timed out") || code === "ETIMEDOUT") return "Timed out"
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ECONNRESET") return "Unreachable"
  if (code === PG_INVALID_PASSWORD || code === PG_INVALID_AUTHORIZATION) return "Auth failed"
  if (code === PG_UNDEFINED_TABLE || code === PG_INVALID_CATALOG_NAME) return "Not provisioned"
  return "Unavailable"
}

export function makeSystemHealthService(deps: SystemHealthServiceDeps): SystemHealthService {
  const { probes, env, log } = deps
  return {
    async health(): Promise<SystemHealthResponse> {
      const api: SystemService = { name: "API", status: "ok", val: "Responding" }

      const [postgres, redis, mediaWorker, ociEmail] = await Promise.all([
        probeRow("Postgres", probes.postgres, NO_PROBE, log),
        probeRow("Redis", probes.redis, NO_PROBE, log),
        probeRow(
          "Media worker",
          env.jobsIsFake ? undefined : probes.mediaWorker,
          { status: "not_deployed", val: "Jobs queue not wired" },
          log,
        ),
        probeRow("OCI Email", probes.ociEmail, NO_PROBE, log),
      ])

      const ociEmailRow: SystemService =
        env.mailerIsFake && ociEmail.status === "ok"
          ? { name: "OCI Email", status: "warn", val: `${ociEmail.val} (fake relay)` }
          : ociEmail

      const glitchTip: SystemService = env.glitchTipConfigured
        ? { name: "GlitchTip", status: "ok", val: "Tracking errors" }
        : { name: "GlitchTip", status: "warn", val: "Not configured" }

      const tileCdn: SystemService = env.tileCdnConfigured
        ? { name: "Basemap", status: "ok", val: "CARTO raster (client default)" }
        : { name: "Basemap", status: "warn", val: "No basemap source" }

      const routing: SystemService = {
        name: "Routing (VRP)",
        status: "not_deployed",
        val: ROUTING_NOT_DEPLOYED_VAL,
      }

      return {
        services: [api, postgres, redis, mediaWorker, ociEmailRow, glitchTip, tileCdn, routing],
      }
    },
  }
}
