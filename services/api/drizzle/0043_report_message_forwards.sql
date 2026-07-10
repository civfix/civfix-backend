-- =============================================================================
-- 0043_report_message_forwards.sql
-- -----------------------------------------------------------------------------
-- Task D-B2: @city forward audit. Records that a report-chat message mentioning
-- @city (jurisdiction handle) was forwarded to that jurisdiction's contact --
-- or, when forwarded_at is NULL, that @city was mentioned but there is no city
-- contact to forward to yet. geoid identifies the jurisdiction (matches
-- jurisdictions.geoid elsewhere in the schema).
--
-- NO foreign key on message_id: chat_messages is RANGE-partitioned with a
-- composite PK(id, created_at), so there is no single-column key to reference
-- -- exactly like chat_message_reactions / chat_message_mentions
-- (0023_message_mentions.sql). App-level integrity holds. geoid is also left
-- unconstrained (no FK to jurisdictions) so forwarding can be recorded even
-- for a geoid not yet present in the jurisdictions table.
--
-- Composite PK(message_id, geoid) means one forward record per
-- (message, jurisdiction) pair.
--
-- This migration ONLY defines the table. Nothing reads/writes it yet (the
-- forward audit lands in D-C4).
--
-- Every statement is idempotent / guarded so re-applying the file is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS report_message_forwards (
  message_id   uuid NOT NULL,
  geoid        text NOT NULL,
  forwarded_at timestamptz,           -- NULL = @city mentioned but not yet forwarded (no city contact)
  PRIMARY KEY (message_id, geoid)
);
