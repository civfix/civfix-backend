import type { Sql } from "../../db/client.js"
import type { DevTestRepository } from "./dev-test-repository.js"

export function makeDrizzleDevTestRepository(_sql: Sql): DevTestRepository {
  throw new Error("not implemented")
}
