-- =============================================================================
-- 0048_chat_polls.sql
-- -----------------------------------------------------------------------------
-- P6 (Polls): a poll is a chat message with kind='poll'. The poll body lives in
-- this trio, keyed on the message's id — chat_polls is 1:1 with the poll
-- message, chat_poll_options is the ordered choice list, chat_poll_votes records
-- one row per (poll, option, voter).
--
-- chat_polls.message_id is a BARE uuid, NOT a foreign key to chat_messages. Same
-- stance as chat_message_reactions (0)/chat pins: chat_messages is PARTITIONED,
-- and an FK pointing AT the partitioned parent is impossible in postgres. Message
-- ids are globally unique (gen_random_uuid across every partition), so keying on
-- the bare id is safe — the app writes the poll row in the same txn as the
-- message and never orphans it.
--
-- created_by gets a REAL FK to users with NO ON DELETE action — the same stance
-- as chat_groups.owner_id (0047): accounts are SOFT-deleted everywhere in the
-- product (users.routes deleteAccount -> softDeleteAndAnonymize; admin bans keep
-- the row), so this FK can never block a deletion path; a tombstoned author just
-- renders as "Deleted User". Vote rows, by contrast, DO cascade on user delete
-- (ON DELETE CASCADE) — a departed voter's ballots vanish rather than lingering.
--
-- chat_poll_options carries a composite PK (poll_id, idx) so a poll's choices are
-- addressed by a small stable ordinal. chat_poll_votes references that composite
-- key so a vote can only point at an option that actually exists on the poll;
-- deleting an option cascades away its votes, and deleting the poll cascades the
-- whole subtree (options -> votes).
--
-- Every statement is idempotent (CREATE TABLE / CREATE INDEX IF NOT EXISTS) so
-- re-applying the file is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS chat_polls (
  message_id     uuid PRIMARY KEY,
  question       text NOT NULL,
  allow_multiple boolean NOT NULL DEFAULT false,
  anonymous      boolean NOT NULL DEFAULT true,
  closed_at      timestamptz,
  created_by     uuid NOT NULL REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_poll_options (
  poll_id uuid     NOT NULL REFERENCES chat_polls (message_id) ON DELETE CASCADE,
  idx     smallint NOT NULL,
  text    text     NOT NULL,
  PRIMARY KEY (poll_id, idx)
);

CREATE TABLE IF NOT EXISTS chat_poll_votes (
  poll_id    uuid     NOT NULL,
  option_idx smallint NOT NULL,
  user_id    uuid     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, option_idx, user_id),
  FOREIGN KEY (poll_id, option_idx) REFERENCES chat_poll_options (poll_id, idx) ON DELETE CASCADE
);

-- "Which polls has this user voted in" lookup (my-votes / cleanup on account
-- delete), mirroring chat_message_reactions_user_idx.
CREATE INDEX IF NOT EXISTS chat_poll_votes_user_idx ON chat_poll_votes (user_id);
