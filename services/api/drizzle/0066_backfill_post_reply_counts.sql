UPDATE posts p
SET reply_count = c.n
FROM (
  SELECT reply_to_id, count(*)::int AS n
  FROM posts
  WHERE reply_to_id IS NOT NULL AND deleted_at IS NULL
  GROUP BY reply_to_id
) c
WHERE p.id = c.reply_to_id
  AND p.reply_count <> c.n;

UPDATE posts p
SET reply_count = 0
WHERE p.reply_count <> 0
  AND NOT EXISTS (
    SELECT 1 FROM posts r WHERE r.reply_to_id = p.id AND r.deleted_at IS NULL
  );
