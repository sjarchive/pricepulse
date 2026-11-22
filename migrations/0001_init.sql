-- PricePulse Cloudflare D1 (SQLite) initial schema

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  platform TEXT NOT NULL,
  platform_label TEXT NOT NULL,
  currency TEXT NOT NULL,
  image_url TEXT,
  current_price REAL NOT NULL,
  initial_price REAL NOT NULL,
  lowest_price REAL NOT NULL,
  highest_price REAL NOT NULL,
  target_price REAL,
  check_interval_hours INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT NOT NULL,
  next_check_at TEXT NOT NULL,
  last_check_status TEXT NOT NULL DEFAULT 'ok',
  last_check_note TEXT,
  in_stock INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  price REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'live',
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_price_history_product_time
  ON price_history(product_id, timestamp);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  default_check_interval_hours INTEGER NOT NULL DEFAULT 1,
  trigger_mode TEXT NOT NULL DEFAULT 'any_drop',
  min_drop_percent INTEGER NOT NULL DEFAULT 5,
  email_enabled INTEGER NOT NULL DEFAULT 0,
  email_address TEXT NOT NULL DEFAULT '',
  telegram_enabled INTEGER NOT NULL DEFAULT 0,
  telegram_chat_id TEXT NOT NULL DEFAULT '',
  push_enabled INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO settings (
  id,
  default_check_interval_hours,
  trigger_mode,
  min_drop_percent,
  email_enabled,
  email_address,
  telegram_enabled,
  telegram_chat_id,
  push_enabled
) VALUES (1, 1, 'any_drop', 5, 0, '', 0, '', 1);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  product_id TEXT,
  product_title TEXT NOT NULL,
  product_url TEXT,
  platform_label TEXT NOT NULL,
  currency TEXT NOT NULL,
  previous_price REAL,
  new_price REAL,
  drop_amount REAL,
  drop_percent REAL,
  triggered_at TEXT NOT NULL,
  message TEXT NOT NULL,
  deliveries_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alerts_triggered_at
  ON alerts(triggered_at DESC);
