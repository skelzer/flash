-- Migration number: 0004 	 multi-user accounts
--
-- Rebuilds decks to drop the global UNIQUE(name) and add user_id.
-- IMPORTANT: DROP TABLE on a parent implicitly deletes its rows first, which
-- fires ON DELETE CASCADE on children. So all three tables are rebuilt and the
-- old ones are dropped child-first (reviews -> cards -> decks), when they no
-- longer have any children left to cascade into.

PRAGMA defer_foreign_keys = on;

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE decks2 (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  front_lang TEXT NOT NULL DEFAULT 'de-DE',
  back_lang TEXT NOT NULL DEFAULT '',
  user_id INTEGER REFERENCES users(id)   -- NULL = legacy rows, claimed by first account
);

CREATE TABLE cards2 (
  id INTEGER PRIMARY KEY,
  deck_id INTEGER NOT NULL REFERENCES decks2(id) ON DELETE CASCADE,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'new',
  due INTEGER NOT NULL DEFAULT 0,
  interval REAL NOT NULL DEFAULT 0,
  ease REAL NOT NULL DEFAULT 2.5,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  step INTEGER NOT NULL DEFAULT 0,
  introduced_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE reviews2 (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards2(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL,
  reviewed_at INTEGER NOT NULL,
  interval REAL NOT NULL
);

INSERT INTO decks2 (id, name, created_at, front_lang, back_lang)
  SELECT id, name, created_at, front_lang, back_lang FROM decks;
INSERT INTO cards2 SELECT * FROM cards;
INSERT INTO reviews2 SELECT * FROM reviews;

DROP TABLE reviews;
DROP TABLE cards;
DROP TABLE decks;

ALTER TABLE decks2 RENAME TO decks;
ALTER TABLE cards2 RENAME TO cards;
ALTER TABLE reviews2 RENAME TO reviews;

CREATE INDEX idx_decks_user ON decks(user_id);
CREATE INDEX idx_cards_deck_state_due ON cards(deck_id, state, due);
CREATE INDEX idx_reviews_time ON reviews(reviewed_at);
