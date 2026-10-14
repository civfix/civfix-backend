-- =============================================================================
-- 0184_media_assets_upload_etag.sql
-- -----------------------------------------------------------------------------
-- WHY. Finalize HEADs the uploaded object and hands its ETag to the media.checks
-- job, and the worker rejects the upload when the bytes it downloads carry a
-- different ETag: the client's presigned PUT stays valid after finalize, so a
-- re-PUT in that window must not be processed as the bytes that were finalized.
-- The ETag only lived in that first job's payload. When the job is lost and the
-- stuck sweep requeues it from the row, the payload had no ETag and the check
-- was skipped. upload_etag keeps it on the row, written in the same UPDATE that
-- claims finalized_at, so the sweep's requeue carries it too.
--
-- BACK-COMPAT: rows finalized before this file keep NULL, and a NULL ETag means
-- the worker skips the comparison exactly as it did before. The column is an
-- opaque object-version string for the row's own bytes (no PII, no location),
-- so it needs no retention rule of its own: it lives and dies with the row.
--
-- HOT TABLE: media_assets. ADD COLUMN IF NOT EXISTS of a NULLable column with
-- NO default and NO index is a catalog-only change on Postgres 11+ (a brief
-- ACCESS EXCLUSIVE lock, no rewrite, no scan). No index: upload_etag is only
-- read off rows already selected by id through the stuck-sweep index.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/media.ts.
-- Forward-only, no down. Requires 0001_core.sql (media_assets).
-- =============================================================================

ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS upload_etag text;
