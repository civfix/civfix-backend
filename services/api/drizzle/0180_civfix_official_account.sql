UPDATE users
SET handle = 'user' || left(replace(id::text, '-', ''), 12)
WHERE handle = 'civfix'
  AND id <> '00000000-0000-4000-8000-00000000c1f1';

INSERT INTO users (
  id,
  role,
  display_name,
  handle,
  email,
  email_verified,
  bio,
  locale,
  profile_complete,
  allow_direct_messages
)
VALUES (
  '00000000-0000-4000-8000-00000000c1f1',
  'citizen',
  'CivFix',
  'civfix',
  NULL,
  false,
  'The official CivFix account.',
  'en',
  true,
  false
)
ON CONFLICT (id) DO NOTHING;
