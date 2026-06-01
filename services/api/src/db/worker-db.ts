/**
 * Worker-facing DB barrel.
 *
 * The media-worker is a SEPARATE pnpm package but must NOT re-declare the Drizzle schema or the
 * postgres-js client: there is exactly one source of truth for the civfix data layer and it lives in
 * @civfix/api. This module is the curated entry the worker imports via the package export
 * "@civfix/api/db" (see services/api/package.json -> exports). It re-exports:
 *
 *   - the full Drizzle schema barrel (media_assets, abuse_flags, chat_messages, ...);
 *   - makeDb + the Db / Sql / DbHandle types (the lazily-connecting postgres-js client factory).
 *
 * Pointing the export at this SOURCE file (not dist) means the worker's tsc and vitest both resolve
 * the exact same types/runtime the API uses, with no duplication and no build-order coupling.
 */

export * as schema from "./schema/index.js"
export { makeDb } from "./client.js"
export type { Db, Sql, DbHandle } from "./client.js"
