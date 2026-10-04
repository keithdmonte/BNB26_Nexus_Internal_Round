-- Phone verification (docs/ABUSE_DEFENSE.md): one verified number per account, one account per number.
-- A number is locked to its account once verified, so it cannot be moved to a second account mid-drop.
ALTER TABLE users ADD COLUMN phone text, ADD COLUMN phone_verified_at timestamptz;
CREATE UNIQUE INDEX users_phone ON users (phone) WHERE phone IS NOT NULL;

-- At most one pending code per user; a new send replaces it.
CREATE TABLE phone_otps (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone      text NOT NULL,
  code_hash  text NOT NULL,
  attempts   int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
