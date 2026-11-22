-- Add server-side salted password hash storage for PricePulse login wall

CREATE TABLE IF NOT EXISTS auth_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
