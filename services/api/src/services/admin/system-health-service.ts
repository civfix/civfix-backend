
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
}

export interface SystemHealthService {
  health(): Promise<SystemHealthResponse>
}

export const MEDIA_WORKER_BACKLOG_WARN = 50

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

function shortReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const firstLine = msg.split("\n")[0] ?? msg
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine
}

export function makeSystemHealthService(deps: SystemHealthServiceDeps): SystemHealthService {
  const { probes, env } = deps
  return {
    async health(): Promise<SystemHealthResponse> {
      const api: SystemService = { name: "API", status: "ok", val: "Responding" }

      const [postgres, redis, mediaWorker, ociEmail] = await Promise.all([
        probeRow("Postgres", probes.postgres, { status: "down", val: "No probe" }),
        probeRow("Redis", probes.redis, { status: "down", val: "No probe" }),
        probeRow("Media worker", env.jobsIsFake ? undefined : probes.mediaWorker, {
          status: "not_deployed",
          val: "Jobs queue not wired",
        }),
        probeRow("OCI Email", probes.ociEmail, { status: "down", val: "No probe" }),
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
