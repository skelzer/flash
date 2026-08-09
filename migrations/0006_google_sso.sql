-- Migration number: 0006 	 Google sign-in
-- Google-only accounts store pass_hash = '' (which can never match a real
-- PBKDF2 output, so password login is naturally impossible for them).
ALTER TABLE users ADD COLUMN google_sub TEXT;
ALTER TABLE users ADD COLUMN email TEXT;
CREATE UNIQUE INDEX idx_users_google ON users(google_sub) WHERE google_sub IS NOT NULL;
