import type { StoredAuthRecord } from '../src/lib/authCrypto';
import { computeNextCheckAt } from '../src/lib/priceUtils';
import type {
  AlertLogEntry,
  AlertSettings,
  ChannelDeliveryResult,
  CurrencyCode,
  PlatformId,
  PricePoint,
  TrackedProduct,
  TriggerMode,
} from '../src/types/tracker';
import type { D1Database } from './types';

interface ProductRow {
  id: string;
  url: string;
  title: string;
  platform: string;
  platform_label: string;
  currency: string;
  image_url: string | null;
  current_price: number;
  initial_price: number;
  lowest_price: number;
  highest_price: number;
  target_price: number | null;
  check_interval_hours: number;
  last_checked_at: string;
  next_check_at: string;
  last_check_status: string;
  last_check_note: string | null;
  in_stock: number;
  created_at: string;
}

interface HistoryRow {
  product_id: string;
  timestamp: string;
  price: number;
  source: string;
}

interface SettingsRow {
  default_check_interval_hours: number;
  trigger_mode: string;
  min_drop_percent: number;
  email_enabled: number;
  email_address: string;
  telegram_enabled: number;
  telegram_chat_id: string;
  push_enabled: number;
}

interface AlertRow {
  id: string;
  type: string;
  product_id: string | null;
  product_title: string;
  product_url: string | null;
  platform_label: string;
  currency: string;
  previous_price: number | null;
  new_price: number | null;
  drop_amount: number | null;
  drop_percent: number | null;
  triggered_at: string;
  message: string;
  deliveries_json: string;
}

interface AuthCredentialsRow {
  username: string;
  password_hash: string;
  updated_at: string;
}

const DEFAULT_SETTINGS: AlertSettings = {
  defaultCheckIntervalHours: 1,
  triggerMode: 'any_drop',
  minDropPercent: 5,
  email: { enabled: false, address: '' },
  telegram: { enabled: false, chatId: '' },
  push: { enabled: true },
};

function mapProductRow(row: ProductRow, history: PricePoint[]): TrackedProduct {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    platform: row.platform as PlatformId,
    platformLabel: row.platform_label,
    currency: row.currency as CurrencyCode,
    imageUrl: row.image_url,
    currentPrice: row.current_price,
    initialPrice: row.initial_price,
    lowestPrice: row.lowest_price,
    highestPrice: row.highest_price,
    targetPrice: row.target_price,
    checkIntervalHours: row.check_interval_hours,
    lastCheckedAt: row.last_checked_at,
    nextCheckAt: row.next_check_at,
    lastCheckStatus: row.last_check_status as 'ok' | 'blocked' | 'error',
    lastCheckNote: row.last_check_note,
    inStock: Boolean(row.in_stock),
    createdAt: row.created_at,
    history,
  };
}

export async function ensureD1Schema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS products (
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
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      price REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'live',
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      default_check_interval_hours INTEGER NOT NULL DEFAULT 1,
      trigger_mode TEXT NOT NULL DEFAULT 'any_drop',
      min_drop_percent INTEGER NOT NULL DEFAULT 5,
      email_enabled INTEGER NOT NULL DEFAULT 0,
      email_address TEXT NOT NULL DEFAULT '',
      telegram_enabled INTEGER NOT NULL DEFAULT 0,
      telegram_chat_id TEXT NOT NULL DEFAULT '',
      push_enabled INTEGER NOT NULL DEFAULT 1
    )`),
    db.prepare(
      `INSERT OR IGNORE INTO settings (id, default_check_interval_hours, trigger_mode, min_drop_percent, email_enabled, email_address, telegram_enabled, telegram_chat_id, push_enabled)
       VALUES (1, 1, 'any_drop', 5, 0, '', 0, '', 1)`
    ),
    db.prepare(`CREATE TABLE IF NOT EXISTS alerts (
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
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS auth_credentials (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
  ]);
}

export async function getAllProductsD1(db: D1Database): Promise<TrackedProduct[]> {
  const [prodRes, histRes] = await Promise.all([
    db.prepare('SELECT * FROM products ORDER BY created_at DESC').all<ProductRow>(),
    db.prepare('SELECT product_id, timestamp, price, source FROM price_history ORDER BY timestamp ASC').all<HistoryRow>(),
  ]);

  const byProduct = new Map<string, PricePoint[]>();
  for (const h of histRes.results) {
    const arr = byProduct.get(h.product_id) || [];
    arr.push({
      timestamp: h.timestamp,
      price: h.price,
      source: h.source === 'manual' ? 'manual' : 'live',
    });
    byProduct.set(h.product_id, arr);
  }

  return prodRes.results.map((row) => mapProductRow(row, byProduct.get(row.id) || []));
}

export async function getProductByIdD1(db: D1Database, id: string): Promise<TrackedProduct | null> {
  const row = await db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<ProductRow>();
  if (!row) return null;

  const histRes = await db
    .prepare('SELECT product_id, timestamp, price, source FROM price_history WHERE product_id = ? ORDER BY timestamp ASC')
    .bind(id)
    .all<HistoryRow>();

  const history: PricePoint[] = histRes.results.map((h) => ({
    timestamp: h.timestamp,
    price: h.price,
    source: h.source === 'manual' ? 'manual' : 'live',
  }));
  return mapProductRow(row, history);
}

export async function insertProductD1(db: D1Database, product: TrackedProduct): Promise<void> {
  const initialPoint = product.history[0] || {
    timestamp: product.createdAt,
    price: product.currentPrice,
    source: 'live',
  };

  await db.batch([
    db
      .prepare(
        `INSERT INTO products (
          id, url, title, platform, platform_label, currency, image_url,
          current_price, initial_price, lowest_price, highest_price, target_price,
          check_interval_hours, last_checked_at, next_check_at,
          last_check_status, last_check_note, in_stock, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        product.id,
        product.url,
        product.title,
        product.platform,
        product.platformLabel,
        product.currency,
        product.imageUrl,
        product.currentPrice,
        product.initialPrice,
        product.lowestPrice,
        product.highestPrice,
        product.targetPrice,
        product.checkIntervalHours,
        product.lastCheckedAt,
        product.nextCheckAt,
        product.lastCheckStatus,
        product.lastCheckNote,
        product.inStock ? 1 : 0,
        product.createdAt
      ),
    db
      .prepare('INSERT INTO price_history (product_id, timestamp, price, source) VALUES (?, ?, ?, ?)')
      .bind(product.id, initialPoint.timestamp, initialPoint.price, initialPoint.source),
  ]);
}

export async function updateProductMetaD1(
  db: D1Database,
  id: string,
  fields: {
    title: string;
    targetPrice: number | null;
    checkIntervalHours: number;
    nextCheckAt: string;
  }
): Promise<TrackedProduct | null> {
  await db
    .prepare(
      'UPDATE products SET title = ?, target_price = ?, check_interval_hours = ?, next_check_at = ? WHERE id = ?'
    )
    .bind(fields.title, fields.targetPrice, fields.checkIntervalHours, fields.nextCheckAt, id)
    .run();
  return getProductByIdD1(db, id);
}

export async function updateProductCheckStatusD1(
  db: D1Database,
  id: string,
  fields: {
    lastCheckedAt: string;
    nextCheckAt: string;
    status: 'ok' | 'blocked' | 'error';
    note: string;
  }
): Promise<TrackedProduct | null> {
  await db
    .prepare(
      'UPDATE products SET last_checked_at = ?, next_check_at = ?, last_check_status = ?, last_check_note = ? WHERE id = ?'
    )
    .bind(fields.lastCheckedAt, fields.nextCheckAt, fields.status, fields.note, id)
    .run();
  return getProductByIdD1(db, id);
}

export async function updateProductPriceD1(
  db: D1Database,
  product: TrackedProduct,
  fields: {
    newPrice: number;
    source: 'live' | 'manual';
    nowIso: string;
    note: string;
    inStock: boolean;
  }
): Promise<TrackedProduct | null> {
  const lowest = Math.min(product.lowestPrice, fields.newPrice);
  const highest = Math.max(product.highestPrice, fields.newPrice);
  const nextCheckAt = computeNextCheckAt(fields.nowIso, product.checkIntervalHours);

  await db.batch([
    db
      .prepare(
        `UPDATE products SET
          current_price = ?, lowest_price = ?, highest_price = ?,
          in_stock = ?, last_checked_at = ?, next_check_at = ?,
          last_check_status = 'ok', last_check_note = ?
        WHERE id = ?`
      )
      .bind(
        fields.newPrice,
        lowest,
        highest,
        fields.inStock ? 1 : 0,
        fields.nowIso,
        nextCheckAt,
        fields.note,
        product.id
      ),
    db
      .prepare('INSERT INTO price_history (product_id, timestamp, price, source) VALUES (?, ?, ?, ?)')
      .bind(product.id, fields.nowIso, fields.newPrice, fields.source),
  ]);

  return getProductByIdD1(db, product.id);
}

export async function deleteProductD1(db: D1Database, id: string): Promise<boolean> {
  const existing = await db.prepare('SELECT id FROM products WHERE id = ?').bind(id).first();
  if (!existing) return false;
  await db.batch([
    db.prepare('DELETE FROM price_history WHERE product_id = ?').bind(id),
    db.prepare('DELETE FROM products WHERE id = ?').bind(id),
  ]);
  return true;
}

export async function getSettingsD1(db: D1Database): Promise<AlertSettings> {
  const row = await db.prepare('SELECT * FROM settings WHERE id = 1').first<SettingsRow>();
  if (!row) return DEFAULT_SETTINGS;
  return {
    defaultCheckIntervalHours: row.default_check_interval_hours,
    triggerMode: row.trigger_mode as TriggerMode,
    minDropPercent: row.min_drop_percent,
    email: {
      enabled: Boolean(row.email_enabled),
      address: row.email_address,
    },
    telegram: {
      enabled: Boolean(row.telegram_enabled),
      chatId: row.telegram_chat_id,
    },
    push: {
      enabled: Boolean(row.push_enabled),
    },
  };
}

export async function saveSettingsD1(
  db: D1Database,
  settings: AlertSettings,
  applyIntervalToAll: boolean
): Promise<AlertSettings> {
  await db
    .prepare(
      `INSERT INTO settings (
        id, default_check_interval_hours, trigger_mode, min_drop_percent,
        email_enabled, email_address, telegram_enabled, telegram_chat_id, push_enabled
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        default_check_interval_hours = excluded.default_check_interval_hours,
        trigger_mode = excluded.trigger_mode,
        min_drop_percent = excluded.min_drop_percent,
        email_enabled = excluded.email_enabled,
        email_address = excluded.email_address,
        telegram_enabled = excluded.telegram_enabled,
        telegram_chat_id = excluded.telegram_chat_id,
        push_enabled = excluded.push_enabled`
    )
    .bind(
      settings.defaultCheckIntervalHours,
      settings.triggerMode,
      settings.minDropPercent,
      settings.email.enabled ? 1 : 0,
      settings.email.address,
      settings.telegram.enabled ? 1 : 0,
      settings.telegram.chatId,
      settings.push.enabled ? 1 : 0
    )
    .run();

  if (applyIntervalToAll) {
    const products = await getAllProductsD1(db);
    if (products.length > 0) {
      const statements = products.map((p) =>
        db
          .prepare('UPDATE products SET check_interval_hours = ?, next_check_at = ? WHERE id = ?')
          .bind(
            settings.defaultCheckIntervalHours,
            computeNextCheckAt(p.lastCheckedAt, settings.defaultCheckIntervalHours),
            p.id
          )
      );
      await db.batch(statements);
    }
  }

  return getSettingsD1(db);
}

export async function getAlertsD1(db: D1Database): Promise<AlertLogEntry[]> {
  const res = await db
    .prepare('SELECT * FROM alerts ORDER BY triggered_at DESC LIMIT 150')
    .all<AlertRow>();

  return res.results.map((row) => {
    let deliveries: ChannelDeliveryResult[] = [];
    try {
      deliveries = JSON.parse(row.deliveries_json) as ChannelDeliveryResult[];
    } catch {
      deliveries = [];
    }
    return {
      id: row.id,
      type: row.type === 'test' ? 'test' : 'price_drop',
      productId: row.product_id,
      productTitle: row.product_title,
      productUrl: row.product_url,
      platformLabel: row.platform_label,
      currency: row.currency as CurrencyCode,
      previousPrice: row.previous_price,
      newPrice: row.new_price,
      dropAmount: row.drop_amount,
      dropPercent: row.drop_percent,
      triggeredAt: row.triggered_at,
      message: row.message,
      deliveries,
    };
  });
}

export async function insertAlertD1(db: D1Database, entry: AlertLogEntry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO alerts (
        id, type, product_id, product_title, product_url, platform_label,
        currency, previous_price, new_price, drop_amount, drop_percent,
        triggered_at, message, deliveries_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      entry.id,
      entry.type,
      entry.productId,
      entry.productTitle,
      entry.productUrl,
      entry.platformLabel,
      entry.currency,
      entry.previousPrice,
      entry.newPrice,
      entry.dropAmount,
      entry.dropPercent,
      entry.triggeredAt,
      entry.message,
      JSON.stringify(entry.deliveries)
    )
    .run();
}

export async function deleteAlertD1(db: D1Database, id: string): Promise<boolean> {
  const existing = await db.prepare('SELECT id FROM alerts WHERE id = ?').bind(id).first();
  if (!existing) return false;
  await db.prepare('DELETE FROM alerts WHERE id = ?').bind(id).run();
  return true;
}

export async function clearAlertsD1(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM alerts').run();
}

export async function getAuthCredentialsD1(db: D1Database): Promise<StoredAuthRecord | null> {
  const row = await db
    .prepare('SELECT username, password_hash, updated_at FROM auth_credentials WHERE id = 1')
    .first<AuthCredentialsRow>();
  if (!row) return null;
  return {
    username: row.username,
    passwordHash: row.password_hash,
    updatedAt: row.updated_at,
  };
}

export async function saveAuthCredentialsD1(
  db: D1Database,
  record: StoredAuthRecord
): Promise<StoredAuthRecord> {
  await db
    .prepare(
      `INSERT INTO auth_credentials (id, username, password_hash, updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         username = excluded.username,
         password_hash = excluded.password_hash,
         updated_at = excluded.updated_at`
    )
    .bind(record.username, record.passwordHash, record.updatedAt)
    .run();
  return record;
}
