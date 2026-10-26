import type { Sql } from "../../db/client.js"
import type { DevJobsRepository } from "./dev-jobs-repository.js"

export function makeDrizzleDevJobsRepository(_sql: Sql): DevJobsRepository {
  return {
    snapshot: () => Promise.reject(new Error("not implemented")),
    runState: () => Promise.reject(new Error("not implemented")),
  }
}
