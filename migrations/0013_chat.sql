-- Live chat: threads entered through the Genius in-chat handoff, plus
-- their messages. Assignment is a column from day one so a round robin
-- can replace first-come claiming later.
CREATE TABLE IF NOT EXISTS chat_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  assigned_admin_id INTEGER,
  status TEXT NOT NULL DEFAULT 'waiting',
  genius_context TEXT,
  ticket_id INTEGER,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  ended_by TEXT,
  last_message_at TEXT
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  sender_user_id INTEGER,
  sender_kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_threads_open ON chat_threads (location_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages (thread_id, id);
