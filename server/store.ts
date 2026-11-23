import fs from 'node:fs';
import path from 'node:path';
import type { StoredAuthRecord } from '../src/lib/authCrypto';
import { computeNextCheckAt } from '../src/lib/priceUtils';
import type {
  AlertLogEntry,
  AlertSettings,
  TrackedProduct,
} from '../src/types/tracker';

export interface TrackerDatabase {
  products: TrackedProduct[];
  settings: AlertSettings;
  alerts: AlertLogEntry[];
  auth?: StoredAuthRecord | null;
  revokedTokens?: Record<string, number>;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'tracker-db.json');

function buildInitialDatabase(): TrackerDatabase {
  const settings: AlertSettings = {
    defaultCheckIntervalHours: 1,
    triggerMode: 'any_drop',
    minDropPercent: 5,
    email: {
      enabled: false,
      address: '',
    },
    telegram: {
      enabled: false,
      chatId: '',
    },
    push: {
      enabled: true,
    },
  };

  return {
    products: [],
    settings,
    alerts: [],
  };
}

class TrackerStore {
  private data: TrackerDatabase;

  constructor() {
    this.data = this.load();
  }

  private load(): TrackerDatabase {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(raw) as TrackerDatabase;
        if (parsed && Array.isArray(parsed.products) && parsed.settings && Array.isArray(parsed.alerts)) {
          return parsed;
        }
      }
    } catch {
      // Fall back to clean initial database if file is missing or corrupted
    }
    const initial = buildInitialDatabase();
    this.persist(initial);
    return initial;
  }

  private persist(next: TrackerDatabase): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const tmpFile = `${DB_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(next, null, 2), 'utf8');
      fs.renameSync(tmpFile, DB_FILE);
    } catch (err) {
      console.error('Failed to persist tracker database:', err);
    }
  }

  public getState(): TrackerDatabase {
    return this.data;
  }

  public getProducts(): TrackedProduct[] {
    return this.data.products;
  }

  public getProductById(id: string): TrackedProduct | undefined {
    return this.data.products.find((p) => p.id === id);
  }

  public addProduct(product: TrackedProduct): TrackedProduct {
    this.data.products = [product, ...this.data.products];
    this.persist(this.data);
    return product;
  }

  public updateProduct(id: string, updater: (current: TrackedProduct) => TrackedProduct): TrackedProduct | null {
    const idx = this.data.products.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    const updated = updater(this.data.products[idx]);
    this.data.products[idx] = updated;
    this.persist(this.data);
    return updated;
  }

  public deleteProduct(id: string): boolean {
    const prevLen = this.data.products.length;
    this.data.products = this.data.products.filter((p) => p.id !== id);
    if (this.data.products.length === prevLen) return false;
    this.persist(this.data);
    return true;
  }

  public getSettings(): AlertSettings {
    return this.data.settings;
  }

  public updateSettings(nextSettings: AlertSettings, applyIntervalToAll: boolean = false): AlertSettings {
    this.data.settings = nextSettings;
    if (applyIntervalToAll) {
      const hours = nextSettings.defaultCheckIntervalHours;
      this.data.products = this.data.products.map((product) => ({
        ...product,
        checkIntervalHours: hours,
        nextCheckAt: computeNextCheckAt(product.lastCheckedAt, hours),
      }));
    }
    this.persist(this.data);
    return this.data.settings;
  }

  public getAlerts(): AlertLogEntry[] {
    return this.data.alerts;
  }

  public appendAlert(entry: AlertLogEntry): AlertLogEntry {
    this.data.alerts = [entry, ...this.data.alerts].slice(0, 150);
    this.persist(this.data);
    return entry;
  }

  public deleteAlert(id: string): boolean {
    const prevLen = this.data.alerts.length;
    this.data.alerts = this.data.alerts.filter((a) => a.id !== id);
    if (this.data.alerts.length === prevLen) return false;
    this.persist(this.data);
    return true;
  }

  public clearAlerts(): number {
    const count = this.data.alerts.length;
    if (count === 0) return 0;
    this.data.alerts = [];
    this.persist(this.data);
    return count;
  }

  public getAuthCredentials(): StoredAuthRecord | null {
    return this.data.auth ?? null;
  }

  public setAuthCredentials(record: StoredAuthRecord): StoredAuthRecord {
    this.data.auth = record;
    this.persist(this.data);
    return record;
  }

  public isTokenRevoked(jti: string, nowSec: number): boolean {
    const map = this.data.revokedTokens;
    if (!map) return false;
    const exp = map[jti];
    if (typeof exp !== 'number') return false;
    if (exp <= nowSec) {
      delete map[jti];
      this.persist(this.data);
      return false;
    }
    return true;
  }

  public revokeToken(jti: string, expSec: number, nowSec: number): void {
    const next: Record<string, number> = {};
    const existing = this.data.revokedTokens || {};
    for (const [key, exp] of Object.entries(existing)) {
      if (typeof exp === 'number' && exp > nowSec) {
        next[key] = exp;
      }
    }
    if (expSec > nowSec) {
      next[jti] = expSec;
    }
    this.data.revokedTokens = next;
    this.persist(this.data);
  }
}

export const trackerStore = new TrackerStore();
