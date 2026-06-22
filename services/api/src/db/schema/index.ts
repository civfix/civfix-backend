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
// boundary-dataset load audit record, stamped by the local refresh tool scripts/refresh-boundaries.ts
// (0028). Canonical DDL: drizzle/0028_boundary_vintage.sql.
export * from "./boundary_vintage.js"
export * from "./reports.js"
export * from "./media.js"
export * from "./timeline.js"

// report discussion (threaded comments + reactions + city mentions). Canonical DDL:
// drizzle/0017_report_discussion.sql.
export * from "./discussion.js"

// cleanups + chat
export * from "./cleanups.js"
export * from "./cleanup_members.js"
// event <-> report junction (0018). The durable source of truth for an event<->report link.
export * from "./cleanup_reports.js"
export * from "./chat.js"
// chat/dm message emoji reactions (0022). One table for BOTH cleanup chat + DM (message ids are uuids,
// globally unique). NO FK into the partitioned message tables. Canonical DDL: drizzle/0022_chat_reactions.sql.
export * from "./chat_reactions.js"
// user @-mentions in discussion + chat/dm messages (0023). report_message_user_mentions FKs the discussion
// message; chat_message_mentions is one table for BOTH cleanup chat + DM (no FK into the partitioned message
// tables). Canonical DDL: drizzle/0023_message_mentions.sql.
export * from "./message_mentions.js"

// direct messages (1:1) + blocking (0009)
export * from "./dm_threads.js"
export * from "./dm_messages.js"
export * from "./dm_read_state.js"
export * from "./user_blocks.js"

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
// per-scope reference-code counters (issue #56). Canonical DDL: drizzle/0030_reference_codes.sql.
export * from "./reference_counters.js"

// Phase 2 (admin / operator): routing contacts, gov queue, user trust, moderation queue, mail,
// outreach throttle, event timeline. Canonical DDL in drizzle/0007_admin_phase2.sql.
export * from "./jurisdiction_contacts.js"
export * from "./gov_claims.js"
export * from "./user_moderation.js"
export * from "./user_verification.js"
export * from "./moderation_items.js"
export * from "./mail.js"
export * from "./inbound_emails.js"
export * from "./outreach_state.js"
export * from "./cleanup_timeline.js"
