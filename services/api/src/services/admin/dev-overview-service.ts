import type { AdminDevOverviewResponse } from "@civfix/contract"
import type { Env } from "../../env.js"
import type { DevJobsService } from "./dev-jobs-service.js"

export interface DevOverviewServiceDeps {
  env: Env
  serviceVersion: string
  startedAt: Date
  contractVersion: string
  nodeVersion: string
  jobs: Pick<DevJobsService, "view">
}

export interface DevOverviewService {
  overview(): Promise<AdminDevOverviewResponse>
}

export function makeDevOverviewService(_deps: DevOverviewServiceDeps): DevOverviewService {
  return { overview: () => Promise.reject(new Error("not implemented")) }
}
