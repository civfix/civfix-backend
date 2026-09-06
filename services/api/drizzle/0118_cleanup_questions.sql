-- =============================================================================
-- 0118_cleanup_questions.sql
-- -----------------------------------------------------------------------------
-- Custom registration questions and the answers to them (W1.3). ONE file: an
-- answer is meaningless without the definition it points at, and the reconcile
-- that rewrites definitions has to reason about both.
--
-- ARCHIVE, NEVER DELETE. `saveEventQuestions` is a full reconcile: a question the
-- host removed from the form gets archived_at stamped, so every existing answer
-- keeps pointing at a LIVE definition row and the host can still read what people
-- said. Deleting the definition would orphan the answers or (worse, with the
-- CASCADE below) silently destroy them. The service never issues a DELETE here;
-- the CASCADE exists only so `DELETE FROM cleanups` in a test teardown is not a
-- two-step dance.
--
-- WHY value_text AND value_json: short/long text and single-select answers are
-- scalars we want indexable and cheaply scrubbable; multi-select and checkbox and
-- consent answers are arrays/booleans. Splitting them keeps the scrub lane a
-- plain `SET value_text = NULL, value_json = NULL` over one partial index instead
-- of a jsonb rewrite, and keeps a text search over answers possible later.
--
-- PRIVACY (W1.8): answers are the most sensitive thing a host collects. They are
-- readable ONLY with the `view_answers` capability (never staff), every read is
-- audited (`event.answers_viewed`), and the retention lane scrubs them 30 days
-- after the event, stamping scrubbed_at so the partial index drains and the lane
-- is idempotent. The attendee's own answers go into /me/data-export; nobody
-- else's do.
--
-- LOCK ORDER (binding on every writer): organizations -> organization_members
-- -> cleanups -> cleanup_members -> cleanup_guests -> cleanup_registrations ->
-- cleanup_registration_seats -> cleanup_answers -> cleanup_waitlist ->
-- cleanup_ticket_types -> cleanup_slots -> cleanup_slot_claims.
--
-- CANONICAL DDL: this file. Drizzle mirror: src/db/schema/cleanup_questions.ts.
-- Ordering rules: requires 0115 (ticket types), 0116 (registrations).
-- =============================================================================

CREATE TABLE IF NOT EXISTS cleanup_questions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_id     uuid        NOT NULL REFERENCES cleanups (id) ON DELETE CASCADE,
  -- NULL = asked of every ticket type.
  ticket_type_id uuid,
  kind           text        NOT NULL,
  prompt         text        NOT NULL,
  help_text      text,
  required       boolean     NOT NULL DEFAULT false,
  options        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  max_selections smallint,
  consent_text   text,
  -- Single-level conditional display: {"questionId": uuid, "equals": string|bool}.
  show_if        jsonb,
  sort_order     smallint    NOT NULL DEFAULT 0,
  archived_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (ticket_type_id, cleanup_id)
    REFERENCES cleanup_ticket_types (id, cleanup_id) ON DELETE CASCADE
);

ALTER TABLE cleanup_questions DROP CONSTRAINT IF EXISTS cleanup_questions_kind_check;
ALTER TABLE cleanup_questions ADD  CONSTRAINT cleanup_questions_kind_check
  CHECK (kind IN ('short_text', 'long_text', 'single_select', 'multi_select', 'checkbox', 'consent'));

ALTER TABLE cleanup_questions DROP CONSTRAINT IF EXISTS cleanup_questions_options_shape;
ALTER TABLE cleanup_questions ADD  CONSTRAINT cleanup_questions_options_shape
  CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) <= 30);

-- A select with no options is an unanswerable question; consent with no text is
-- an unreadable agreement.
ALTER TABLE cleanup_questions DROP CONSTRAINT IF EXISTS cleanup_questions_kind_payload;
ALTER TABLE cleanup_questions ADD  CONSTRAINT cleanup_questions_kind_payload
  CHECK (
    (kind NOT IN ('single_select', 'multi_select') OR jsonb_array_length(options) > 0)
    AND (kind <> 'consent' OR consent_text IS NOT NULL)
  );

-- FK target for cleanup_answers' composite reference.
CREATE UNIQUE INDEX IF NOT EXISTS cleanup_questions_id_cleanup_uidx
  ON cleanup_questions (id, cleanup_id);

-- The ordered live form.
CREATE INDEX IF NOT EXISTS cleanup_questions_live_idx
  ON cleanup_questions (cleanup_id, sort_order, id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS cleanup_questions_type_idx
  ON cleanup_questions (ticket_type_id)
  WHERE ticket_type_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cleanup_answers (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_id      uuid        NOT NULL REFERENCES cleanups (id) ON DELETE CASCADE,
  registration_id uuid        NOT NULL REFERENCES cleanup_registrations (id) ON DELETE CASCADE,
  question_id     uuid        NOT NULL REFERENCES cleanup_questions (id) ON DELETE CASCADE,
  value_text      text,
  value_json      jsonb,
  scrubbed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (question_id, cleanup_id)
    REFERENCES cleanup_questions (id, cleanup_id) ON DELETE CASCADE
);

ALTER TABLE cleanup_answers DROP CONSTRAINT IF EXISTS cleanup_answers_value_exclusive;
ALTER TABLE cleanup_answers ADD  CONSTRAINT cleanup_answers_value_exclusive
  CHECK (value_text IS NULL OR value_json IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS cleanup_answers_registration_question_uidx
  ON cleanup_answers (registration_id, question_id);

-- Retention lane: scrub 30 days post-event. Drains as it stamps.
CREATE INDEX IF NOT EXISTS cleanup_answers_unscrubbed_idx
  ON cleanup_answers (cleanup_id)
  WHERE scrubbed_at IS NULL;

CREATE INDEX IF NOT EXISTS cleanup_answers_question_idx
  ON cleanup_answers (question_id);

COMMENT ON TABLE cleanup_questions IS
  'Host-defined registration questions. Removing one ARCHIVES it (archived_at); definitions are never deleted so answers keep a live parent.';
COMMENT ON TABLE cleanup_answers IS
  'Registration answers. view_answers capability only, audited read, scrubbed 30 days post-event (scrubbed_at).';
