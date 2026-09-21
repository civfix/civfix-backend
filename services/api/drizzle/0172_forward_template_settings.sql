-- =============================================================================
-- 0172_forward_template_settings.sql
-- -----------------------------------------------------------------------------
-- The PLATFORM-WIDE default forwarding email template (report -> jurisdiction).
--
-- 0050 gave each jurisdiction an optional custom template. This table adds the
-- layer beneath it: one operator-editable default that applies to every
-- jurisdiction with no custom template of its own. Resolution order when a
-- packet is built (mail-format.ts buildReportPacket):
--   jurisdictions.forward_*_template -> this row -> the built-in default
--   (DEFAULT_FORWARD_SUBJECT_TEMPLATE / DEFAULT_FORWARD_BODY_TEMPLATE in
--   @civfix/shared, which is what the packet rendered before this table existed).
--
-- Singleton by construction: `id smallint PRIMARY KEY CHECK (id = 1)` means the
-- upsert is `INSERT ... ON CONFLICT (id) DO UPDATE` and no query ever has to
-- pick a "current" row. Both template columns are NULLABLE: NULL = fall through
-- to the built-in default. An empty string from the PUT is normalized to NULL in
-- the service (the handle-clear convention 0050 follows), so only a genuinely
-- non-empty template overrides.
--
-- The bounds live in the shared Zod schema (SetForwardTemplateDefaultRequest,
-- which also rejects unknown {tokens} and {{double braces}}); no DB CHECK on the
-- text, by the same convention as jurisdictions.forward_*_template.
--
-- updated_by is the operator who last saved, recorded for the audit trail. It is
-- deliberately NOT a FK to users: the row must survive an operator account being
-- deleted, and the authoritative trail is the audit_log row written in the same
-- transaction (action `mail.forward_template_set`).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS makes re-applying a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS forward_template_settings (
  id               smallint PRIMARY KEY CHECK (id = 1),
  subject_template text,
  body_template    text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid NULL
);
