ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS auth_verdict text;

UPDATE mail_messages m
SET auth_verdict = e.meta->>'authVerdict'
FROM mail_events e
WHERE e.message_id = m.id::text
  AND e.type = 'delivered'
  AND e.meta->>'authVerdict' IN ('pass', 'fail', 'unknown')
  AND m.direction = 'in'
  AND m.auth_verdict IS NULL;

CREATE INDEX IF NOT EXISTS mail_messages_inbound_created_idx
  ON mail_messages (created_at DESC, id DESC)
  WHERE direction = 'in';
