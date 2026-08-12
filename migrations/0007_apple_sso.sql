-- Migration number: 0007 	 Sign in with Apple
-- Apple-only accounts store pass_hash = '' like the Google ones, so password
-- login can never match for them. apple_sub is Apple's stable per-app user id;
-- it sits alongside google_sub so one account can carry both.
ALTER TABLE users ADD COLUMN apple_sub TEXT;
CREATE UNIQUE INDEX idx_users_apple ON users(apple_sub) WHERE apple_sub IS NOT NULL;
