import { describe, it, expect } from "vitest"
import {
  makeSystemHealthService,
  MEDIA_WORKER_BACKLOG_WARN,
  type SystemHealthEnv,
  type SystemHealthProbes,
} from "../../src/services/admin/system-health-service.js"


const FULL_ENV: SystemHealthEnv = {
  glitchTipConfigured: true,
  tileCdnConfigured: true,
  mailerIsFake: false,
  jobsIsFake: false,
}

function row(services: { name: string; status: string; val: string }[], name: string) {
  return services.find((s) => s.name === name)
}

describe("system health assembly", () => {
  it("reports ok rows when every probe resolves", async () => {
    const probes: SystemHealthProbes = {
      postgres: async () => ({ val: "5 jurisdictions", status: "ok" }),
      redis: async () => ({ val: "PONG", status: "ok" }),
      mediaWorker: async () => ({ val: "depth 3", status: "ok" }),
      ociEmail: async () => ({ val: "12 events 7d", status: "ok" }),
    }
    const svc = makeSystemHealthService({ probes, env: FULL_ENV })
    const { services } = await svc.health()

    expect(row(services, "API")).toEqual({ name: "API", status: "ok", val: "Responding" })
    expect(row(services, "Postgres")).toMatchObject({ status: "ok", val: "5 jurisdictions" })
    expect(row(services, "Redis")).toMatchObject({ status: "ok", val: "PONG" })
    expect(row(services, "Media worker")).toMatchObject({ status: "ok", val: "depth 3" })
    expect(row(services, "OCI Email")).toMatchObject({ status: "ok", val: "12 events 7d" })
    expect(row(services, "GlitchTip")).toMatchObject({ status: "ok" })
    expect(row(services, "Basemap")).toMatchObject({
      status: "ok",
      val: "CARTO raster (client default)",
    })
    expect(row(services, "Routing (VRP)")).toEqual({
      name: "Routing (VRP)",
      status: "not_deployed",
      val: "Phase 3",
    })
  })

  it("a probe that REJECTS becomes a 'down' row (never throws)", async () => {
    const probes: SystemHealthProbes = {
      postgres: async () => {
        throw new Error("connection refused")
      },
      redis: async () => ({ val: "PONG" }),
      mediaWorker: async () => ({ val: "depth 0" }),
      ociEmail: async () => ({ val: "0 events 7d" }),
    }
    const svc = makeSystemHealthService({ probes, env: FULL_ENV })
    const { services } = await svc.health()
    const pg = row(services, "Postgres")!
    expect(pg.status).toBe("down")
    expect(pg.val).toContain("connection refused")
    expect(row(services, "Redis")?.status).toBe("ok")
  })

  it("an absent probe yields a fallback row (down 'No probe')", async () => {
    const svc = makeSystemHealthService({ probes: {}, env: FULL_ENV })
    const { services } = await svc.health()
    expect(row(services, "Postgres")).toMatchObject({ status: "down", val: "No probe" })
    expect(row(services, "Redis")).toMatchObject({ status: "down", val: "No probe" })
  })

  it("media worker is 'not_deployed' when jobs are faked (no real pg-boss queue)", async () => {
    const probes: SystemHealthProbes = {
      mediaWorker: async () => ({ val: "depth 3" }),
    }
    const svc = makeSystemHealthService({
      probes,
      env: { ...FULL_ENV, jobsIsFake: true },
    })
    const { services } = await svc.health()
    expect(row(services, "Media worker")).toEqual({
      name: "Media worker",
      status: "not_deployed",
      val: "Jobs queue not wired",
    })
  })

  it("media worker warns past the backlog threshold (probe-supplied status honored)", async () => {
    const probes: SystemHealthProbes = {
      mediaWorker: async () => ({ val: `depth ${MEDIA_WORKER_BACKLOG_WARN + 1}`, status: "warn" }),
    }
    const svc = makeSystemHealthService({ probes, env: FULL_ENV })
    const { services } = await svc.health()
    expect(row(services, "Media worker")?.status).toBe("warn")
  })

  it("OCI Email warns under the fake mailer even when the probe is ok", async () => {
    const probes: SystemHealthProbes = {
      ociEmail: async () => ({ val: "3 events 7d", status: "ok" }),
    }
    const svc = makeSystemHealthService({
      probes,
      env: { ...FULL_ENV, mailerIsFake: true },
    })
    const { services } = await svc.health()
    const oci = row(services, "OCI Email")!
    expect(oci.status).toBe("warn")
    expect(oci.val).toContain("fake relay")
  })

  it("GlitchTip / Basemap reflect configuration", async () => {
    const svc = makeSystemHealthService({
      probes: {},
      env: { glitchTipConfigured: false, tileCdnConfigured: false, mailerIsFake: false, jobsIsFake: false },
    })
    const { services } = await svc.health()
    expect(row(services, "GlitchTip")).toMatchObject({ status: "warn", val: "Not configured" })
    expect(row(services, "Basemap")).toMatchObject({ status: "warn", val: "No basemap source" })
  })
})
