/**
 * Drizzle schema barrel.
 *
 * Re-exports every domain table plus the shared custom column types and enum value tuples. Importing
 * `* as schema` from here is what `drizzle({ schema })` (src/db/client.ts) binds to, and what
 * drizzle-kit reads (drizzle.config.ts -> schema: ./src/db/schema/index.ts).
 *
 * REMINDER: the hand-authored SQL under services/api/drizzle is the canonical DDL (PostGIS geometry,
 * GiST indexes, declarative partitioning). These table definitions exist for typed queries and for
 * drizzle-kit diff inspection only; they are NOT applied to create the database.
 */

// custom types + enum tuples
export * from "./types.js"

// identity / auth
export * from "./users.js"
export * from "./oauth.js"
export * from "./otp.js"
export * from "./sessions.js"

// geo / reports
export * from "./jurisdictions.js"
export * from "./reports.js"
export * from "./media.js"
export * from "./timeline.js"

// cleanups + chat
export * from "./cleanups.js"
export * from "./cleanup_members.js"
export * from "./chat.js"

// social
export * from "./follows.js"

// notifications / push
export * from "./notifications.js"
export * from "./notification_prefs.js"
export * from "./push_tokens.js"

// anon / moderation / infra
export * from "./anon.js"
export * from "./moderation.js"
export * from "./idempotency.js"
export * from "./discovery.js"
export * from "./audit.js"
