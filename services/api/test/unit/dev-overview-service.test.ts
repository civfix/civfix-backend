import { describe, expect, it } from "vitest"
import { FakeJobs } from "@civfix/seams"
import { loadEnv } from "../../src/env.js"
import { makeDevJobsService } from "../../src/services/admin/dev-jobs-service.js"
import {
  makeDevOverviewService,
  type DevOverviewServiceDeps,
} from "../../src/services/admin/dev-overview-service.js"
import { InMemoryDevJobsRepository } from "../helpers/admin/dev-jobs-repository.memory.js"

const NOW = new Date(Date.UTC(2026, 9, 26, 12, 0, 0, 0))
const HOUR = 60 * 60 * 1000
const API_IMAGE = `ghcr.io/civfix/api@sha256:${"a".repeat(64)}`
const WORKER_IMAGE = `ghcr.io/civfix/media-worker@sha256:${"b".repeat(64)}`

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms)
}

function setup(
  source: NodeJS.ProcessEnv = {},
  overrides: Partial<Pick<DevOverviewServiceDeps, "serviceVersion">> = {},
) {
  const env = loadEnv({ NODE_ENV: "test", ...source })
  const repo = new InMemoryDevJobsRepository(() => NOW)
  const jobs = makeDevJobsService({
    repo,
    jobs: new FakeJobs(),
    jobsIsFake: env.USE_FAKE_JOBS,
    audit: () => Promise.resolve(),
    now: () => NOW,
  })
  const service = makeDevOverviewService({
    env,
    serviceVersion: overrides.serviceVersion ?? "0.0.0",
    startedAt: ago(HOUR),
    contractVersion: "0.67.0",
    nodeVersion: "v22.0.0",
    jobs,
  })
  return { repo, service }
}

describe("makeDevOverviewService", () => {
  it("T2: reports the environment and the build refs", async () => {
    const { service } = setup(
      {
        CIVFIX_ENV: "staging",
        CIVFIX_RELEASE_REF: "main",
        CIVFIX_API_IMAGE_REF: API_IMAGE,
        CIVFIX_WORKER_IMAGE_REF: WORKER_IMAGE,
      },
      { serviceVersion: "3f9c2ab01d4e5f60" },
    )
    const overview = await service.overview()
    expect(overview.environment).toBe("staging")
    expect(overview.api).toMatchObject({
      commit: "3f9c2ab01d4e5f60",
      releaseRef: "main",
      image: API_IMAGE,
    })
    expect(overview.worker.image).toBe(WORKER_IMAGE)
  })

  it("T3: an unset service version is no commit", async () => {
    const { service } = setup({}, { serviceVersion: "0.0.0" })
    expect((await service.overview()).api.commit).toBe(null)
  })

  it("T6: one seam per fake flag, in FAKE_SEAM_FLAGS order", async () => {
    const { service } = setup({
      USE_FAKE_STORAGE: "false",
      USE_FAKE_MAILER: "true",
      USE_FAKE_PUSH: "false",
      USE_FAKE_ABUSE_NSFW: "false",
      USE_FAKE_CHAT: "false",
      USE_FAKE_JOBS: "true",
      USE_FAKE_USER_CHANNEL: "false",
      USE_FAKE_GEOCODER: "false",
      USE_FAKE_SMS: "false",
      DATABASE_URL: "postgres://localhost:5432/civfix",
    })
    expect((await service.overview()).seams).toEqual([
      { name: "storage", mode: "real" },
      { name: "mailer", mode: "fake" },
      { name: "push", mode: "real" },
      { name: "abuse_nsfw", mode: "real" },
      { name: "chat", mode: "real" },
      { name: "jobs", mode: "fake" },
      { name: "user_channel", mode: "real" },
      { name: "geocoder", mode: "real" },
      { name: "sms", mode: "real" },
    ])
  })

  it("T12: the worker's last job is the newest completion of a worker-owned queue", async () => {
    const { repo, service } = setup({ USE_FAKE_JOBS: "false" })
    repo.addJob("orphan.sweep", "completed", { completedOn: ago(3 * HOUR) })
    repo.addArchived("retention.sweep", "completed", ago(HOUR), ago(HOUR))
    repo.addJob("inbound.sweep", "completed", { completedOn: ago(60 * 1000) })
    repo.addJob("media.checks", "failed", { completedOn: ago(30 * 1000) })
    expect((await service.overview()).worker.lastJobCompletedAt).toBe(ago(HOUR).toISOString())

    const none = setup({ USE_FAKE_JOBS: "false" })
    none.repo.addJob("inbound.sweep", "completed", { completedOn: ago(60 * 1000) })
    none.repo.addJob("media.checks", "failed", { completedOn: ago(30 * 1000) })
    expect((await none.service.overview()).worker.lastJobCompletedAt).toBe(null)
  })

  it("T13: with fake jobs the worker's last job is null and pg-boss is never read", async () => {
    const { repo, service } = setup({ USE_FAKE_JOBS: "true" })
    repo.addJob("orphan.sweep", "completed", { completedOn: ago(HOUR) })
    expect((await service.overview()).worker.lastJobCompletedAt).toBe(null)
    expect(repo.snapshotCalls).toEqual([])
    expect(repo.runStateCalls).toBe(0)
  })
})
