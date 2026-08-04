-- Migration number: 0003 	 cards are English on the front, German on the back
UPDATE decks SET front_lang = 'en-US', back_lang = 'de-DE';
