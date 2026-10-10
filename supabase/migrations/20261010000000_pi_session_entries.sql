-- Pi's native session entries include compaction checkpoints and the retained transcript.
ALTER TABLE pi.threads RENAME COLUMN messages TO entries;

-- Existing local transcripts have no compaction checkpoint yet. Wrap their
-- messages once in Pi's append-only session format; runtime reads one format.
UPDATE pi.threads AS thread
SET entries = (
  SELECT jsonb_build_array(jsonb_build_object(
    'type', 'session', 'version', 3, 'id', thread.thread_id,
    'timestamp', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'cwd', '/workspace'
  )) || coalesce(jsonb_agg(jsonb_build_object(
    'type', 'message',
    'id', substr(md5(thread.thread_id || ':' || item.ordinality::text), 1, 8),
    'parentId', CASE WHEN item.ordinality = 1 THEN NULL
      ELSE substr(md5(thread.thread_id || ':' || (item.ordinality - 1)::text), 1, 8) END,
    'timestamp', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'message', item.message
  ) ORDER BY item.ordinality), '[]'::jsonb)
  FROM jsonb_array_elements(thread.entries) WITH ORDINALITY AS item(message, ordinality)
);
