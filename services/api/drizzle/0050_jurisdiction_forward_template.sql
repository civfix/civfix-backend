-- =============================================================================
-- 0050_jurisdiction_forward_template.sql
-- -----------------------------------------------------------------------------
-- Per-jurisdiction custom forwarding email template (report -> jurisdiction).
--
-- Adds two nullable text columns to `jurisdictions` that let an operator override
-- the built-in default packet civfix forwards to a routing contact:
--   forward_subject_template — the Subject line template (max 300, app-side via
--     the shared PatchJurisdictionRequest bound); interpolated with the report's
--     {referenceCode}/{category}/{place}/… tokens (FORWARD_TEMPLATE_VARIABLES).
--   forward_body_template — the body template (max 8000, app-side bound); split
--     on blank lines into paragraph blocks and rendered through the civfix card.
--
-- Both are NULLABLE: NULL = use the built-in refined default (see mail-format.ts
-- buildReportPacket). An empty string from the PATCH clears back to NULL (the
-- handle-clear convention), so only a genuinely non-empty template overrides.
-- The bounds live in the shared Zod schema (PatchJurisdictionRequestSchema); no
-- DB CHECK by the same convention the other jurisdictions text columns follow.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS makes re-applying a no-op.
-- =============================================================================

ALTER TABLE jurisdictions
  ADD COLUMN IF NOT EXISTS forward_subject_template text,
  ADD COLUMN IF NOT EXISTS forward_body_template text;
