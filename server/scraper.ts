import dns from 'node:dns/promises';
import net from 'node:net';
import * as cheerio from 'cheerio';
import {
  detectPlatform,
  inferTitleFromUrl,
  normalizeUrlInput,
  sanitizeExternalUrl,
} from '../src/lib/priceUtils';
import type { CurrencyCode, UrlPreviewResult } from '../src/types/tracker';

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8500;
const MAX_REDIRECTS = 3;

export function isPrivateOrReservedIp(ip: string): boolean {
  const cleanIp = ip.trim().toLowerCase();

  if (net.isIPv4(cleanIp)) {
    const parts = cleanIp.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  if (net.isIPv6(cleanIp)) {
    if (cleanIp === '::1' || cleanIp === '::') return true;
    if (cleanIp.startsWith('fc') || cleanIp.startsWith('fd')) return true;
    if (cleanIp.startsWith('fe8') || cleanIp.startsWith('fe9') || cleanIp.startsWith('fea') || cleanIp.startsWith('feb')) {
      return true;
    }
    if (cleanIp.startsWith('::ffff:')) {
      const mapped = cleanIp.slice(7);
      if (net.isIPv4(mapped)) return isPrivateOrReservedIp(mapped);
    }
    return false;
  }

  return true;
}

export async function validatePublicShoppingUrl(rawUrl: string): Promise<URL> {
  const normalized = normalizeUrlInput(rawUrl);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('Please enter a valid product URL starting with https://');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// product links are supported.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('URLs containing embedded credentials are not allowed.');
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('Local or internal hostnames cannot be tracked.');
  }

  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new Error('Private or reserved IP addresses cannot be tracked.');
    }
    return parsed;
  }

  try {
    const records = await dns.lookup(host, { all: true });
    if (!records || records.length === 0) {
      throw new Error('Could not resolve store domain.');
    }
    for (const rec of records) {
      if (isPrivateOrReservedIp(rec.address)) {
        throw new Error('Store hostname resolved to a private or restricted network address.');
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('restricted')) {
      throw err;
    }
    // If DNS is unavailable in a restricted sandbox, still permit standard public domains
    // while strictly rejecting raw IPs or local domains already checked above.
    if (!host.includes('.')) {
      throw new Error('Please enter a valid public store domain.');
    }
  }

  return parsed;
}

export function parsePriceNumber(raw: string | number | null | undefined): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? Number(raw.toFixed(2)) : null;
  }
  if (!raw || typeof raw !== 'string') return null;

  const cleaned = raw
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Match first reasonable price figure with optional commas and decimals
  const match = cleaned.match(/(?:₹|Rs\.?|INR|\$|USD|£|GBP|€|EUR)?\s*([0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/i);
  if (!match) return null;

  const numericStr = match[1].replace(/,/g, '');
  const value = Number.parseFloat(numericStr);
  if (!Number.isFinite(value) || value <= 0 || value > 50_000_000) return null;
  return Number(value.toFixed(2));
}

function detectCurrencyCode(raw: string | undefined, fallback: CurrencyCode): CurrencyCode {
  if (!raw) return fallback;
  const upper = raw.toUpperCase();
  if (upper.includes('INR') || upper.includes('₹') || upper.includes('RS')) return 'INR';
  if (upper.includes('USD') || upper.includes('$')) return 'USD';
  if (upper.includes('GBP') || upper.includes('£')) return 'GBP';
  if (upper.includes('EUR') || upper.includes('€')) return 'EUR';
  return fallback;
}

function extractFromJsonLd($: cheerio.CheerioAPI): {
  title?: string;
  price?: number;
  currency?: string;
  image?: string;
  inStock?: boolean;
} {
  const scripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    const raw = $(scripts[i]).text();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const nodes = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed['@graph'])
          ? parsed['@graph']
          : [parsed];

      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const typeField = node['@type'];
        const isProduct =
          typeField === 'Product' ||
          (Array.isArray(typeField) && typeField.includes('Product'));
        if (!isProduct) continue;

        const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
        const rawPrice =
          offers?.price ??
          offers?.lowPrice ??
          offers?.priceSpecification?.price ??
          node.price;
        const parsedPrice = parsePriceNumber(rawPrice);
        const imageField = Array.isArray(node.image) ? node.image[0] : node.image;
        const imageUrl = typeof imageField === 'string' ? imageField : imageField?.url;
        const availability = String(offers?.availability || '').toLowerCase();

        return {
          title: typeof node.name === 'string' ? node.name.trim() : undefined,
          price: parsedPrice ?? undefined,
          currency: typeof offers?.priceCurrency === 'string' ? offers.priceCurrency : undefined,
          image: typeof imageUrl === 'string' ? imageUrl : undefined,
          inStock: availability ? !availability.includes('outofstock') : true,
        };
      }
    } catch {
      // Ignore malformed JSON-LD blocks
    }
  }
  return {};
}

export function extractProductFromHtml(html: string, urlStr: string): UrlPreviewResult {
  const { platform, platformLabel, currency: defaultCurrency } = detectPlatform(urlStr);
  const $ = cheerio.load(html);

  const jsonLd = extractFromJsonLd($);

  const metaTitle =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="twitter:title"]').attr('content') ||
    $('#productTitle').text() ||
    $('h1.VU-ZEz, h1.yhB1nd, h1.pdp-title, h1.pdp-name, h1').first().text() ||
    $('title').text();

  const cleanTitle = (jsonLd.title || metaTitle || '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[-|:]\s*(Amazon\.in|Amazon\.com|Flipkart\.com|Myntra|Ajio|Croma|Nykaa|Walmart|Best Buy).*$/i, '')
    .trim();

  let price: number | null = jsonLd.price ?? null;
  let detectedCurrencyRaw: string | undefined = jsonLd.currency;

  if (price === null) {
    const metaPrice =
      $('meta[property="product:price:amount"]').attr('content') ||
      $('meta[property="og:price:amount"]').attr('content') ||
      $('meta[itemprop="price"]').attr('content');
    detectedCurrencyRaw =
      detectedCurrencyRaw ||
      $('meta[property="product:price:currency"]').attr('content') ||
      $('meta[property="og:price:currency"]').attr('content');
    price = parsePriceNumber(metaPrice);
  }

  if (price === null) {
    const selectorList: string[] = [];
    if (platform === 'amazon') {
      selectorList.push(
        '.a-price .a-offscreen',
        '#priceblock_ourprice',
        '#priceblock_dealprice',
        '#corePriceDisplay_desktop_feature_div .a-price-whole',
        '.priceToPay .a-offscreen'
      );
    } else if (platform === 'flipkart') {
      selectorList.push('.Nx9bqj.CxhGGd', '.Nx9bqj', '._30jeq3._16Jk6d', '._30jeq3');
    } else if (platform === 'myntra') {
      selectorList.push('.pdp-price strong', '.pdp-discount-container strong');
    } else if (platform === 'croma') {
      selectorList.push('#pdp-product-price', '.pdpPriceMrp .amount', '.amount');
    }
    selectorList.push('[itemprop="price"]', '[data-testid="price"]', '.product-price', '.price');

    for (const sel of selectorList) {
      const text = $(sel).first().text().trim() || $(sel).first().attr('content');
      const parsed = parsePriceNumber(text);
      if (parsed !== null) {
        price = parsed;
        if (text) detectedCurrencyRaw = detectedCurrencyRaw || text;
        break;
      }
    }
  }

  // Myntra often embeds JSON inside window.__myx script tag
  if (price === null && platform === 'myntra') {
    const myxMatch = html.match(/"discountedPrice"\s*:\s*(\d+(?:\.\d+)?)/);
    if (myxMatch) {
      price = parsePriceNumber(myxMatch[1]);
    }
  }

  const rawImage =
    jsonLd.image ||
    $('meta[property="og:image"]').attr('content') ||
    $('#landingImage').attr('src') ||
    $('img._396cs4, img.DByuf4').first().attr('src') ||
    null;

  const safeImage = sanitizeExternalUrl(rawImage);
  const currency = detectCurrencyCode(detectedCurrencyRaw, defaultCurrency);
  const finalTitle = cleanTitle.length >= 3 ? cleanTitle : inferTitleFromUrl(urlStr);

  const isCaptcha = /enter the characters you see below|robot check|captcha|access denied/i.test(
    $('title').text() + ' ' + $('body').text().slice(0, 600)
  );

  if (isCaptcha && price === null) {
    return {
      url: urlStr,
      platform,
      platformLabel,
      currency,
      title: inferTitleFromUrl(urlStr),
      price: null,
      imageUrl: null,
      inStock: true,
      fetchStatus: 'blocked',
      note: `${platformLabel} requested a bot check. Confirm the product title and current price below to track it.`,
    };
  }

  if (price !== null) {
    return {
      url: urlStr,
      platform,
      platformLabel,
      currency,
      title: finalTitle,
      price,
      imageUrl: safeImage,
      inStock: jsonLd.inStock ?? true,
      fetchStatus: 'extracted',
      note: `Live price extracted from ${platformLabel}.`,
    };
  }

  return {
    url: urlStr,
    platform,
    platformLabel,
    currency,
    title: finalTitle,
    price: null,
    imageUrl: safeImage,
    inStock: true,
    fetchStatus: 'partial',
    note: `Detected ${platformLabel} product details, but the store renders its price dynamically. Enter the current price below to begin tracking.`,
  };
}

async function fetchHtmlSafely(initialUrl: URL): Promise<{ html: string; finalUrl: string } | null> {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(currentUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache',
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return null;
        const nextUrl = new URL(location, currentUrl);
        currentUrl = await validatePublicShoppingUrl(nextUrl.toString());
        continue;
      }

      if (!res.ok) {
        return null;
      }

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        return null;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        const text = await res.text();
        return { html: text.slice(0, MAX_HTML_BYTES), finalUrl: currentUrl.toString() };
      }

      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > MAX_HTML_BYTES) {
            chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - MAX_HTML_BYTES))));
            break;
          }
          chunks.push(value);
        }
      }
      const combined = Buffer.concat(chunks).toString('utf8');
      return { html: combined, finalUrl: currentUrl.toString() };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

export async function previewProductUrl(rawUrl: string): Promise<UrlPreviewResult> {
  const validated = await validatePublicShoppingUrl(rawUrl);
  const urlStr = validated.toString();
  const { platform, platformLabel, currency } = detectPlatform(urlStr);

  const fetched = await fetchHtmlSafely(validated);
  if (!fetched) {
    return {
      url: urlStr,
      platform,
      platformLabel,
      currency,
      title: inferTitleFromUrl(urlStr),
      price: null,
      imageUrl: null,
      inStock: true,
      fetchStatus: 'blocked',
      note: `Could not fetch live page directly from ${platformLabel} (store protection or timeout). Confirm the title and current price below to start tracking.`,
    };
  }

  return extractProductFromHtml(fetched.html, fetched.finalUrl);
}
