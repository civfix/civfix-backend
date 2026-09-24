-- 0100_mail_messages_affiliation_effects.sql
--
-- H5 + M(inbound side effects): the facts an inbound thread message has to carry.
--
-- `unaffiliated`: the message reached the thread by echoing a thread token or an outbound Message-ID
-- (both disclosed to every recipient of a forwarded packet) but its From domain does NOT align with any
-- address civfix actually mailed on that thread. Such a message is still stored (audit trail) but must
-- never drive an official-city-reply effect, a bounce, or recipient resolution.
--
-- The effects columns exist because side effects (report status transition, reporter notification, event
-- timeline) used to be fire-and-forget after an insert deduped on message_id, so one transient failure
-- lost the transition forever. They are a LEASE, not a flag:
--
--   effects_claimed_at  a runner holds the message. RECLAIMABLE: the sweep re-drives any claim older than
--                       its lease, because a process death between claim and completion (a deploy
--                       restart, OOM, the drain watchdog) would otherwise strand the row forever; the
--                       exact failure the fix is for, just narrower.
--   effects_applied_at  set ONLY on completion. `IS NULL` is the "still owed" set the partial index
--                       serves; the lease comparison stays in the query because now() is not IMMUTABLE.
--   effects_stage       how far the ordered pipeline got (0 none, 1 timeline, 2 chat, 3 reporter
--                       notified). A re-drive resumes from here, so a throw in a later step can never
--                       append a SECOND public timeline row / chat message / push.
--
-- mail_messages is a small operator-plane table (one row per outbound packet / inbound reply), not a hot
-- table, so a plain CREATE INDEX inside the migration transaction is safe.

ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS unaffiliated boolean NOT NULL DEFAULT false;
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS effects_claimed_at timestamptz;
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS effects_applied_at timestamptz;
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS effects_stage integer NOT NULL DEFAULT 0;

-- SETTLE EVERY PRE-EXISTING INBOUND ROW. The pending set is "direction='in' AND effects_applied_at IS
-- NULL" with no created_at floor, so without this every historical inbound reply would match on the first
-- inbound.sweep after deploy and be re-driven at stage 0: a second "The city responded" timeline row, a
-- chat system message, a push, and thread status forced back to 'replied' over a closed or bounced
-- thread: 100 per run until drained, including senders the affiliation gate never applied to. Their
-- effects already ran under the old fire-and-forget path, so they are marked applied at their own
-- created_at with the pipeline recorded complete. Idempotent (only touches rows still NULL).
UPDATE mail_messages
SET effects_applied_at = COALESCE(effects_applied_at, created_at),
    effects_stage = 3
WHERE direction = 'in' AND effects_applied_at IS NULL;

-- The sweep's re-drive predicate: inbound, affiliated, effects not yet applied. The lease check is
-- applied in the query (now() is not IMMUTABLE and so cannot appear in an index predicate).
CREATE INDEX IF NOT EXISTS mail_messages_effects_pending_idx
  ON mail_messages (created_at)
  WHERE direction = 'in' AND unaffiliated = false AND effects_applied_at IS NULL;
