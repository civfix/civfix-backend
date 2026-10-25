import type { Sql } from "../../db/client.js"
import type { RuntimeFlagRepository } from "./runtime-flag-repository.js"

export function makeDrizzleRuntimeFlagRepository(_sql: Sql): RuntimeFlagRepository {
  throw new Error("not implemented")
}
