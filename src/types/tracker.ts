export type PlatformId =
  | 'amazon'
  | 'flipkart'
  | 'myntra'
  | 'ajio'
  | 'nykaa'
  | 'croma'
  | 'reliancedigital'
  | 'meesho'
  | 'tatacliq'
  | 'walmart'
  | 'bestbuy'
  | 'target'
  | 'ebay'
  | 'apple'
  | 'other';

export type CurrencyCode = 'INR' | 'USD' | 'GBP' | 'EUR';

export type TriggerMode = 'any_drop' | 'percent_drop' | 'target_price';

export interface PricePoint {
  timestamp: string;
  price: number;
  source: 'live' | 'manual';
}

export interface TrackedProduct {
  id: string;
  url: string;
  title: string;
  platform: PlatformId;
  platformLabel: string;
  currency: CurrencyCode;
  imageUrl: string | null;
  currentPrice: number;
  initialPrice: number;
  lowestPrice: number;
  highestPrice: number;
  targetPrice: number | null;
  checkIntervalHours: number;
  lastCheckedAt: string;
  nextCheckAt: string;
  lastCheckStatus: 'ok' | 'blocked' | 'error';
  lastCheckNote: string | null;
  inStock: boolean;
  createdAt: string;
  history: PricePoint[];
}

export interface AlertSettings {
  defaultCheckIntervalHours: number;
  triggerMode: TriggerMode;
  minDropPercent: number;
  email: {
    enabled: boolean;
    address: string;
  };
  telegram: {
    enabled: boolean;
    chatId: string;
  };
  push: {
    enabled: boolean;
  };
}

export interface ServerCapabilities {
  emailConfigured: boolean;
  telegramBotConfigured: boolean;
}

export type ChannelDeliveryStatus = 'sent' | 'logged' | 'disabled' | 'failed';

export interface ChannelDeliveryResult {
  channel: 'email' | 'telegram' | 'push';
  status: ChannelDeliveryStatus;
  destination: string;
  detail: string;
}

export interface AlertLogEntry {
  id: string;
  type: 'price_drop' | 'test';
  productId: string | null;
  productTitle: string;
  productUrl: string | null;
  platformLabel: string;
  currency: CurrencyCode;
  previousPrice: number | null;
  newPrice: number | null;
  dropAmount: number | null;
  dropPercent: number | null;
  triggeredAt: string;
  message: string;
  deliveries: ChannelDeliveryResult[];
}

export interface UrlPreviewResult {
  url: string;
  platform: PlatformId;
  platformLabel: string;
  currency: CurrencyCode;
  title: string;
  price: number | null;
  imageUrl: string | null;
  inStock: boolean;
  fetchStatus: 'extracted' | 'partial' | 'blocked';
  note: string;
}

export interface BootstrapResponse {
  products: TrackedProduct[];
  settings: AlertSettings;
  alerts: AlertLogEntry[];
  capabilities: ServerCapabilities;
}

export interface SseAlertEvent {
  type: 'alert';
  alert: AlertLogEntry;
}
