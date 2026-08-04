-- Migration number: 0002 	 per-deck TTS languages
-- BCP-47 tag for speech synthesis; empty string = no speech button
ALTER TABLE decks ADD COLUMN front_lang TEXT NOT NULL DEFAULT 'de-DE';
ALTER TABLE decks ADD COLUMN back_lang TEXT NOT NULL DEFAULT '';
