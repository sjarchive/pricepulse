import type {
  AlertSettings,
  CurrencyCode,
  PlatformId,
  TrackedProduct,
} from '../types/tracker';

export const MIN_CHECK_INTERVAL_HOURS = 1;
export const MAX_CHECK_INTERVAL_HOURS = 720;

export interface PlatformMeta {
  id: PlatformId;
  label: string;
  domains: string[];
  defaultCurrency: CurrencyCode;
}

export const SUPPORTED_PLATFORMS: PlatformMeta[] = [
  {
    id: 'amazon',
    label: 'Amazon',
    domains: ['amazon.in', 'amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.ca', 'amzn.in', 'amzn.to'],
    defaultCurrency: 'INR',
  },
  {
    id: 'flipkart',
    label: 'Flipkart',
    domains: ['flipkart.com', 'dl.flipkart.com', 'fkrt.it'],
    defaultCurrency: 'INR',
  },
  {
    id: 'myntra',
    label: 'Myntra',
    domains: ['myntra.com'],
    defaultCurrency: 'INR',
  },
  {
    id: 'ajio',
    label: 'Ajio',
    domains: ['ajio.com'],
    defaultCurrency: 'INR',
  },
  {
    id: 'nykaa',
    label: 'Nykaa',
    domains: ['nykaa.com', 'nykaafashion.com'],
    defaultCurrency: 'INR',
  },
  {
    id: 'croma',
    label: 'Croma',
    domains: ['croma.com'],
    defaultCurrency: 'INR',
  },
  {
    id: 'reliancedigital',
    label: 'Reliance Digital',
    domains: ['reliancedigital.in'],
    defaultCurrency: 'INR',
  },
  {
    id: 'meesho',
    label: 'Meesho',
    domains: ['meesho.com'],
    defaultCurrency: 'INR',
  },
  {
    id: 'tatacliq',
    label: 'Tata CLiQ',
    domains: ['tatacliq.com'],
    defaultCurrency: 'INR',
  },
  {
    id: 'walmart',
    label: 'Walmart',
    domains: ['walmart.com'],
    defaultCurrency: 'USD',
  },
  {
    id: 'bestbuy',
    label: 'Best Buy',
    domains: ['bestbuy.com'],
    defaultCurrency: 'USD',
  },
  {
    id: 'target',
    label: 'Target',
    domains: ['target.com'],
    defaultCurrency: 'USD',
  },
  {
    id: 'ebay',
    label: 'eBay',
    domains: ['ebay.com', 'ebay.co.uk', 'ebay.in'],
    defaultCurrency: 'USD',
  },
  {
    id: 'apple',
    label: 'Apple Store',
    domains: ['apple.com'],
    defaultCurrency: 'USD',
  },
];

export function normalizeUrlInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

export function detectPlatform(urlStr: string): {
  platform: PlatformId;
  platformLabel: string;
  currency: CurrencyCode;
} {
  let hostname = '';
  try {
    const parsed = new URL(normalizeUrlInput(urlStr));
    hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return { platform: 'other', platformLabel: 'Online Store', currency: 'INR' };
  }

  for (const meta of SUPPORTED_PLATFORMS) {
    const matched = meta.domains.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
    if (matched) {
      let currency: CurrencyCode = meta.defaultCurrency;
      if (hostname.endsWith('.in') || hostname === 'amzn.in') {
        currency = 'INR';
      } else if (hostname.endsWith('.co.uk')) {
        currency = 'GBP';
      } else if (hostname.endsWith('.de') || hostname.endsWith('.fr') || hostname.endsWith('.es')) {
        currency = 'EUR';
      } else if (hostname.endsWith('.com') && meta.id === 'amazon') {
        currency = 'USD';
      }
      return {
        platform: meta.id,
        platformLabel: meta.label,
        currency,
      };
    }
  }

  const labelPart = hostname.split('.')[0] || 'Online Store';
  const formattedLabel = labelPart.charAt(0).toUpperCase() + labelPart.slice(1);
  const currency: CurrencyCode = hostname.endsWith('.in')
    ? 'INR'
    : hostname.endsWith('.co.uk')
      ? 'GBP'
      : hostname.endsWith('.eu') || hostname.endsWith('.de')
        ? 'EUR'
        : 'USD';

  return {
    platform: 'other',
    platformLabel: formattedLabel,
    currency,
  };
}

export function inferTitleFromUrl(urlStr: string): string {
  try {
    const parsed = new URL(normalizeUrlInput(urlStr));
    const segments = parsed.pathname
      .split('/')
      .map((s) => decodeURIComponent(s).trim())
      .filter((s) => s.length > 0);

    const ignoredTokens = new Set([
      'dp',
      'gp',
      'product',
      'products',
      'p',
      'buy',
      'shop',
      'item',
      'itm',
      'ip',
      'site',
      'ref',
      'in',
      'en',
    ]);

    const candidates = segments.filter((seg) => {
      const lower = seg.toLowerCase();
      if (ignoredTokens.has(lower)) return false;
      if (/^[a-z0-9]{8,12}$/i.test(seg) && !seg.includes('-')) return false;
      if (/^\d+$/.test(seg)) return false;
      return seg.length >= 4;
    });

    if (candidates.length === 0) {
      const { platformLabel } = detectPlatform(urlStr);
      return `${platformLabel} Tracked Product`;
    }

    const best = candidates.sort((a, b) => b.length - a.length)[0];
    const cleaned = best
      .replace(/\.(html|htm|php)$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) {
      const { platformLabel } = detectPlatform(urlStr);
      return `${platformLabel} Tracked Product`;
    }

    return cleaned
      .split(' ')
      .slice(0, 12)
      .map((w) => (w.length <= 3 && /^[a-z0-9]+$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(' ');
  } catch {
    return 'Tracked Product';
  }
}

export function validateCheckInterval(hours: number): {
  valid: boolean;
  value: number;
  error?: string;
} {
  if (!Number.isFinite(hours)) {
    return {
      valid: false,
      value: MIN_CHECK_INTERVAL_HOURS,
      error: 'Check interval must be a valid number of hours.',
    };
  }
  if (hours < MIN_CHECK_INTERVAL_HOURS) {
    return {
      valid: false,
      value: MIN_CHECK_INTERVAL_HOURS,
      error: `Minimum check interval is ${MIN_CHECK_INTERVAL_HOURS} hour.`,
    };
  }
  if (hours > MAX_CHECK_INTERVAL_HOURS) {
    return {
      valid: false,
      value: MAX_CHECK_INTERVAL_HOURS,
      error: `Maximum check interval is ${MAX_CHECK_INTERVAL_HOURS} hours (30 days).`,
    };
  }
  return {
    valid: true,
    value: Math.round(hours),
  };
}

export function computeNextCheckAt(fromIso: string, intervalHours: number): string {
  const baseMs = Date.parse(fromIso);
  const safeMs = Number.isNaN(baseMs) ? Date.now() : baseMs;
  const clampedHours = Math.max(MIN_CHECK_INTERVAL_HOURS, Math.min(MAX_CHECK_INTERVAL_HOURS, Math.round(intervalHours)));
  return new Date(safeMs + clampedHours * 60 * 60 * 1000).toISOString();
}

export interface PriceDropEvaluation {
  isDrop: boolean;
  dropAmount: number;
  dropPercent: number;
  shouldNotify: boolean;
  reason: string;
}

export function evaluatePriceDrop(
  previousPrice: number,
  newPrice: number,
  targetPrice: number | null,
  settings: Pick<AlertSettings, 'triggerMode' | 'minDropPercent'>
): PriceDropEvaluation {
  if (!Number.isFinite(previousPrice) || !Number.isFinite(newPrice) || previousPrice <= 0 || newPrice <= 0) {
    return {
      isDrop: false,
      dropAmount: 0,
      dropPercent: 0,
      shouldNotify: false,
      reason: 'Invalid price values.',
    };
  }

  const diff = Number((previousPrice - newPrice).toFixed(2));
  if (diff <= 0) {
    return {
      isDrop: false,
      dropAmount: 0,
      dropPercent: 0,
      shouldNotify: false,
      reason: diff === 0 ? 'Price unchanged.' : 'Price increased.',
    };
  }

  const dropPercent = Number(((diff / previousPrice) * 100).toFixed(2));
  const hitTarget = targetPrice !== null && newPrice <= targetPrice;

  if (settings.triggerMode === 'target_price') {
    if (hitTarget) {
      return {
        isDrop: true,
        dropAmount: diff,
        dropPercent,
        shouldNotify: true,
        reason: 'Dropped to or below target price.',
      };
    }
    return {
      isDrop: true,
      dropAmount: diff,
      dropPercent,
      shouldNotify: false,
      reason: targetPrice === null
        ? 'No target price set for this product.'
        : 'Dropped, but still above target price.',
    };
  }

  if (settings.triggerMode === 'percent_drop') {
    const threshold = Math.max(1, settings.minDropPercent || 5);
    if (dropPercent >= threshold || hitTarget) {
      return {
        isDrop: true,
        dropAmount: diff,
        dropPercent,
        shouldNotify: true,
        reason: hitTarget
          ? 'Hit target price.'
          : `Dropped by ${dropPercent}% (threshold ${threshold}%).`,
      };
    }
    return {
      isDrop: true,
      dropAmount: diff,
      dropPercent,
      shouldNotify: false,
      reason: `Drop of ${dropPercent}% is below your ${threshold}% alert threshold.`,
    };
  }

  // any_drop
  return {
    isDrop: true,
    dropAmount: diff,
    dropPercent,
    shouldNotify: true,
    reason: `Price dropped by ${dropPercent}%.`,
  };
}

export function formatCurrency(amount: number, currency: CurrencyCode): string {
  const localeMap: Record<CurrencyCode, string> = {
    INR: 'en-IN',
    USD: 'en-US',
    GBP: 'en-GB',
    EUR: 'de-DE',
  };
  try {
    return new Intl.NumberFormat(localeMap[currency] || 'en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: currency === 'INR' && Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    const symbols: Record<CurrencyCode, string> = { INR: '₹', USD: '$', GBP: '£', EUR: '€' };
    return `${symbols[currency] || ''}${amount.toFixed(2)}`;
  }
}

export function sanitizeExternalUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/src/assets/images/') && !trimmed.includes('..')) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

export function getPriceChangePercent(product: Pick<TrackedProduct, 'currentPrice' | 'initialPrice'>): number {
  if (!product.initialPrice || product.initialPrice <= 0) return 0;
  return Number((((product.currentPrice - product.initialPrice) / product.initialPrice) * 100).toFixed(1));
}

export function formatRelativeTime(iso: string, nowMs: number = Date.now()): string {
  const targetMs = Date.parse(iso);
  if (Number.isNaN(targetMs)) return 'Recently';
  const diffSec = Math.round((nowMs - targetMs) / 1000);
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.round(diffHr / 24);
  return `${diffDays}d ago`;
}

export function formatCountdown(iso: string, nowMs: number = Date.now()): string {
  const targetMs = Date.parse(iso);
  if (Number.isNaN(targetMs)) return 'Scheduled';
  const diffSec = Math.round((targetMs - nowMs) / 1000);
  if (diffSec <= 0) return 'Due now';
  const diffMin = Math.ceil(diffSec / 60);
  if (diffMin < 60) return `In ${diffMin}m`;
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  if (hours < 24) {
    return mins > 0 ? `In ${hours}h ${mins}m` : `In ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `In ${days}d ${hours % 24}h`;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function isValidTelegramChatId(chatId: string): boolean {
  return /^-?\d{5,20}$/.test(chatId.trim());
}
