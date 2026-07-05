-- =============================================================================
-- 0034_user_social_links.sql
-- -----------------------------------------------------------------------------
-- Public social-media links shown on a user's profile (Facebook / Instagram /
-- TikTok / X handles + a WhatsApp number). Stored as a single nullable JSONB
-- object ({ facebook?, instagram?, tiktok?, x?, whatsapp? }) rather than five
-- columns so adding a platform later is a contract + UI change with NO migration.
--
-- SECURITY: only the bare username/handle (or, for WhatsApp, the E.164 digits) is
-- ever stored — never a full URL — and each value is validated against a strict
-- charset by the shared SocialLinksSchema at the write boundary. Clients build the
-- canonical https:// link from a fixed template (socialLinkUrl), so there is no
-- open-redirect / javascript: surface in the stored data.
--
-- NULL => the user has set no links (clients render nothing). Additive + nullable,
-- so existing rows are unaffected on apply.
-- -----------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS social_links jsonb;
