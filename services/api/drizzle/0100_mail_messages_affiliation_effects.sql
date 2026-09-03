-- 0100_mail_messages_affiliation_effects.sql
--
-- H5 + M(inbound side effects): two facts an inbound thread message has to carry.
--
-- `unaffiliated` — the message reached the thread by echoing a thread token or an outbound Message-ID
-- (both disclosed to every recipient of a forwarded packet) but its From domain does NOT align with any
-- address civfix actually mailed on that thread. Such a message is still stored (audit trail) but must
-- never drive an official-city-reply effect, a bounce, or recipient resolution.
--
-- `effects_applied_at` — inbound side effects (report status transition, reporter notification, event
-- timeline) used to be fire-and-forget after an insert deduped on message_id, so one transient failure
-- lost the transition forever. The column makes the step idempotent and re-drivable by the sweep.
--
-- mail_messages is a small operator-plane table (one row per outbound packet / inbound reply), not a hot
-- table, so a plain CREATE INDEX inside the migration transaction is safe.

ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS unaffiliated boolean NOT NULL DEFAULT false;
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS effects_applied_at timestamptz;

-- The sweep's re-drive predicate: inbound, affiliated, effects not yet applied.
CREATE INDEX IF NOT EXISTS mail_messages_effects_pending_idx
  ON mail_messages (created_at)
  WHERE direction = 'in' AND unaffiliated = false AND effects_applied_at IS NULL;
