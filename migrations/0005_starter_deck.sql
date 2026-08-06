-- Migration number: 0005 	 starter deck flag
-- A deck flagged is_starter=1 is cloned for new users (and offered to users
-- with no decks). The flag is set manually on the owner's deck.
ALTER TABLE decks ADD COLUMN is_starter INTEGER NOT NULL DEFAULT 0;
