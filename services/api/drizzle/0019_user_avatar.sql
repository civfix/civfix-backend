-- 0019_user_avatar.sql
--
-- User profile picture: a nullable FK from users to the media asset that backs the user's avatar. The
-- media row is created through the normal presign -> PUT -> finalize pipeline (purpose stays 'report' -
-- avatars are public, served like any report image); PUT /me/profile resolves the finalized upload id to
-- this media row and stores its id here. NULL => the client renders the solid-color + letter monogram (or
-- the provider avatar_url when present). ON DELETE SET NULL so removing the media row orphans the avatar
-- rather than deleting the user.

ALTER TABLE users
  ADD COLUMN avatar_media_id uuid REFERENCES media_assets(id) ON DELETE SET NULL;
