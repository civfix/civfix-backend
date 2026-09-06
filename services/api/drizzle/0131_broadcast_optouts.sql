-- =============================================================================
-- 0131_broadcast_optouts.sql
-- -----------------------------------------------------------------------------
-- The two suppression lists a broadcast must consult before it sends (W2.1).
-- Both are kept INDEFINITELY on purpose, for the same reason sms_opt_outs (0096)
-- is: a suppression list that expires quietly re-enables mailing someone who
-- explicitly said stop.
--
--   broadcast_unsubscribes  the person's own choice, captured either from the
--                           RFC 8058 one-click header (reason 'one_click') or
--                           from a console/app toggle ('manual'), or recorded
--                           after a spam complaint ('complaint'). scope 'event'
--                           narrows it to one event; scope 'global' silences
--                           every host broadcast on the platform. Bulk kinds
--                           honour both; the two critical kinds do not, because
--                           "this event is cancelled" is a service message.
--   email_suppressions      addresses the mail provider rejected permanently
--                           (hard bounce) or that generated a complaint. Keyed
--                           by sha256(lower(trim(email))) so the table is a
--                           suppression list, NOT a directory of who has ever
--                           been emailed: it cannot be read back into an address
--                           and it cannot be joined to a person. NO kind bypasses
--                           it -- sending to a hard-bounced address is how a
--                           sending domain loses its reputation.
--
-- CANONICAL DDL: hand-authored source of truth. Mirrors:
-- schema/broadcast_unsubscribes.ts, schema/email_suppressions.ts.
--
-- Conventions: CREATE TABLE / CREATE INDEX IF NOT EXISTS; one concern per file.
-- =============================================================================

CREATE TABLE IF NOT EXISTS broadcast_unsubscribes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope        text NOT NULL,
  cleanup_id   uuid REFERENCES cleanups(id) ON DELETE CASCADE,
  subject_kind text NOT NULL,
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  guest_id     uuid REFERENCES cleanup_guests(id) ON DELETE CASCADE,
  reason       text NOT NULL DEFAULT 'one_click',
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broadcast_unsubscribes_scope_check CHECK (scope IN ('event','global')),
  CONSTRAINT broadcast_unsubscribes_subject_kind_check CHECK (subject_kind IN ('user','guest')),
  CONSTRAINT broadcast_unsubscribes_reason_check CHECK (reason IN ('one_click','manual','complaint')),
  CONSTRAINT broadcast_unsubscribes_scope_event_check CHECK (
    (scope = 'event' AND cleanup_id IS NOT NULL) OR (scope = 'global' AND cleanup_id IS NULL)),
  CONSTRAINT broadcast_unsubscribes_subject_check CHECK (
    (subject_kind = 'user' AND user_id IS NOT NULL AND guest_id IS NULL)
    OR (subject_kind = 'guest' AND guest_id IS NOT NULL AND user_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS broadcast_unsubscribes_event_user_uidx
  ON broadcast_unsubscribes (cleanup_id, user_id)
  WHERE scope = 'event' AND subject_kind = 'user';

CREATE UNIQUE INDEX IF NOT EXISTS broadcast_unsubscribes_event_guest_uidx
  ON broadcast_unsubscribes (cleanup_id, guest_id)
  WHERE scope = 'event' AND subject_kind = 'guest';

CREATE UNIQUE INDEX IF NOT EXISTS broadcast_unsubscribes_global_user_uidx
  ON broadcast_unsubscribes (user_id)
  WHERE scope = 'global' AND subject_kind = 'user';

CREATE UNIQUE INDEX IF NOT EXISTS broadcast_unsubscribes_global_guest_uidx
  ON broadcast_unsubscribes (guest_id)
  WHERE scope = 'global' AND subject_kind = 'guest';

CREATE INDEX IF NOT EXISTS broadcast_unsubscribes_cleanup_created_idx
  ON broadcast_unsubscribes (cleanup_id, created_at);

CREATE TABLE IF NOT EXISTS email_suppressions (
  email_hash text PRIMARY KEY,
  reason     text NOT NULL,
  hits       integer NOT NULL DEFAULT 1,
  first_at   timestamptz NOT NULL DEFAULT now(),
  last_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_suppressions_reason_check CHECK (reason IN ('hard_bounce','complaint','manual')),
  CONSTRAINT email_suppressions_hash_check CHECK (email_hash ~ '^[0-9a-f]{64}$')
);
