import type { AdminDevJobsResponse, AdminDevRunJobResponse } from "@civfix/contract"
import type { Jobs } from "@civfix/seams"
import type { WriteAuditInput } from "./audit.js"
import type { DevJobsRepository } from "./dev-jobs-repository.js"

export interface DevJobsServiceDeps {
  repo: DevJobsRepository
  jobs: Jobs
  jobsIsFake: boolean
  audit: (input: WriteAuditInput) => Promise<void>
  now?: () => Date
}

export interface DevJobsService {
  view(): Promise<AdminDevJobsResponse>
  runNow(name: string, actorId: string): Promise<AdminDevRunJobResponse>
}

export function makeDevJobsService(_deps: DevJobsServiceDeps): DevJobsService {
  return {
    view: () => Promise.reject(new Error("not implemented")),
    runNow: () => Promise.reject(new Error("not implemented")),
  }
}
