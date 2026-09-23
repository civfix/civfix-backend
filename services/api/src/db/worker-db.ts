/**
 * The media worker's only entry into the data layer (package export "@civfix/api/db"), so the schema and
 * client are never re-declared there. The export points at this source file rather than dist, so the
 * worker's tsc and vitest resolve the same types the API uses with no build-order coupling.
 */

export * as schema from "./schema/index.js"
export { makeDb } from "./client.js"
export type { Db, Sql, DbHandle, TransactionSql, Queryable } from "./client.js"
