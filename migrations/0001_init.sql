-- Migration number: 0001 	 flash initial schema

CREATE TABLE decks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE cards (
  id INTEGER PRIMARY KEY,
  deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  -- scheduling state
  state TEXT NOT NULL DEFAULT 'new',      -- new | learning | review | relearning
  due INTEGER NOT NULL DEFAULT 0,         -- epoch ms
  interval REAL NOT NULL DEFAULT 0,       -- days
  ease REAL NOT NULL DEFAULT 2.5,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  step INTEGER NOT NULL DEFAULT 0,        -- position in learning/relearning steps
  introduced_at INTEGER,                  -- when the card first left 'new'
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_cards_deck_state_due ON cards(deck_id, state, due);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL,                -- 1 again, 2 hard, 3 good, 4 easy
  reviewed_at INTEGER NOT NULL,
  interval REAL NOT NULL                  -- interval (days) after this review
);

CREATE INDEX idx_reviews_time ON reviews(reviewed_at);
