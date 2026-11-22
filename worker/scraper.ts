import {
  detectPlatform,
  inferTitleFromUrl,
  normalizeUrlInput,
  sanitizeExternalUrl,
} from '../src/lib/priceUtils';
import type { CurrencyCode, UrlPreviewResult } from '../src/types/tracker';
import type { WorkersAiBinding } from './types';

const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;
const WORKERS_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';

function isPrivateOrReservedIpv4(host: string): boolean {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((n) => n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

export function validateEdgePublicUrl(rawUrl: string): URL {
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

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '::1' ||
    host === '::' ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe8') ||
    host.startsWith('fe9') ||
    host.startsWith('fea') ||
    host.startsWith('feb') ||
    host.startsWith('::ffff:') ||
    isPrivateOrReservedIpv4(host)
  ) {
    throw new Error('Local, private, or internal hostnames cannot be tracked.');
  }

  if (!host.includes('.')) {
    throw new Error('Please enter a valid public store domain.');
  }

  return parsed;
}

export function parseEdgePriceNumber(raw: string | number | null | undefined): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? Number(raw.toFixed(2)) : null;
  }
  if (!raw || typeof raw !== 'string') return null;

  const cleaned = raw.replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
  const match = cleaned.match(
    /(?:₹|Rs\.?|INR|\$|USD|£|GBP|€|EUR)?\s*([0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/i
  );
  if (!match) return null;
  const value = Number.parseFloat(match[1].replace(/,/g, ''));
  if (!Number.isFinite(value) || value <= 0 || value > 50_000_000) return null;
  return Number(value.toFixed(2));
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectCurrency(raw: string | undefined, fallback: CurrencyCode): CurrencyCode {
  if (!raw) return fallback;
  const upper = raw.toUpperCase();
  if (upper.includes('INR') || upper.includes('₹') || upper.includes('RS')) return 'INR';
  if (upper.includes('USD') || upper.includes('$')) return 'USD';
  if (upper.includes('GBP') || upper.includes('£')) return 'GBP';
  if (upper.includes('EUR') || upper.includes('€')) return 'EUR';
  return fallback;
}

function extractMetaTag(html: string, attrName: string, attrValue: string): string | null {
  const escaped = attrValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const p1 = new RegExp(
    `<meta[^>]*${attrName}=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    'i'
  );
  const m1 = html.match(p1);
  if (m1?.[1]) return decodeHtmlEntities(m1[1]);

  const p2 = new RegExp(
    `<meta[^>]*content=["']([^"']+)["'][^>]*${attrName}=["']${escaped}["'][^>]*>`,
    'i'
  );
  const m2 = html.match(p2);
  return m2?.[1] ? decodeHtmlEntities(m2[1]) : null;
}

function extractJsonLdProduct(html: string): {
  title?: string;
  price?: number;
  currency?: string;
  image?: string;
  inStock?: boolean;
} {
  const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) {
    const raw = match[1]?.trim();
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
        const t = node['@type'];
        const isProduct = t === 'Product' || (Array.isArray(t) && t.includes('Product'));
        if (!isProduct) continue;

        const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
        const rawPrice =
          offers?.price ??
          offers?.lowPrice ??
          offers?.priceSpecification?.price ??
          node.price;
        const parsedPrice = parseEdgePriceNumber(rawPrice);
        const img = Array.isArray(node.image) ? node.image[0] : node.image;
        const imageUrl = typeof img === 'string' ? img : img?.url;
        const availability = String(offers?.availability || '').toLowerCase();

        return {
          title: typeof node.name === 'string' ? decodeHtmlEntities(node.name) : undefined,
          price: parsedPrice ?? undefined,
          currency: typeof offers?.priceCurrency === 'string' ? offers.priceCurrency : undefined,
          image: typeof imageUrl === 'string' ? imageUrl : undefined,
          inStock: availability ? !availability.includes('outofstock') : true,
        };
      }
    } catch {
      // Skip malformed JSON-LD blocks
    }
  }
  return {};
}

export function extractProductFromHtmlEdge(html: string, urlStr: string): UrlPreviewResult {
  const { platform, platformLabel, currency: defaultCurrency } = detectPlatform(urlStr);
  const jsonLd = extractJsonLdProduct(html);

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const amazonTitleMatch = html.match(/id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i);

  const rawTitle =
    jsonLd.title ||
    extractMetaTag(html, 'property', 'og:title') ||
    extractMetaTag(html, 'name', 'twitter:title') ||
    (amazonTitleMatch?.[1] ? decodeHtmlEntities(amazonTitleMatch[1]) : null) ||
    (titleMatch?.[1] ? decodeHtmlEntities(titleMatch[1]) : '');

  const cleanTitle = rawTitle
    .replace(/\s*[-|:]\s*(Amazon\.in|Amazon\.com|Flipkart\.com|Myntra|Ajio|Croma|Nykaa|Walmart|Best Buy).*$/i, '')
    .trim();

  let price: number | null = jsonLd.price ?? null;
  let currencyRaw: string | undefined = jsonLd.currency;

  if (price === null) {
    const metaPrice =
      extractMetaTag(html, 'property', 'product:price:amount') ||
      extractMetaTag(html, 'property', 'og:price:amount') ||
      extractMetaTag(html, 'itemprop', 'price');
    currencyRaw =
      currencyRaw ||
      extractMetaTag(html, 'property', 'product:price:currency') ||
      extractMetaTag(html, 'property', 'og:price:currency') ||
      undefined;
    price = parseEdgePriceNumber(metaPrice);
  }

  if (price === null && platform === 'amazon') {
    const m =
      html.match(/class=["'][^"']*a-offscreen[^"']*["'][^>]*>([^<]+)</i) ||
      html.match(/id=["']priceblock_(?:our|deal)price["'][^>]*>([^<]+)</i);
    if (m?.[1]) {
      price = parseEdgePriceNumber(m[1]);
      currencyRaw = currencyRaw || m[1];
    }
  }

  if (price === null && platform === 'flipkart') {
    const m =
      html.match(/class=["'][^"']*(?:Nx9bqj|_30jeq3)[^"']*["'][^>]*>([^<]+)</i) ||
      html.match(/"finalPrice"\s*:\s*(\d+(?:\.\d+)?)/);
    if (m?.[1]) {
      price = parseEdgePriceNumber(m[1]);
      currencyRaw = currencyRaw || m[1];
    }
  }

  if (price === null && platform === 'myntra') {
    const m = html.match(/"discountedPrice"\s*:\s*(\d+(?:\.\d+)?)/);
    if (m?.[1]) {
      price = parseEdgePriceNumber(m[1]);
    }
  }

  const rawImage =
    jsonLd.image ||
    extractMetaTag(html, 'property', 'og:image') ||
    extractMetaTag(html, 'name', 'twitter:image') ||
    null;

  const safeImage = sanitizeExternalUrl(rawImage);
  const currency = detectCurrency(currencyRaw, defaultCurrency);
  const finalTitle = cleanTitle.length >= 3 ? cleanTitle : inferTitleFromUrl(urlStr);

  const isCaptcha = /enter the characters you see below|robot check|captcha|access denied/i.test(
    html.slice(0, 4000)
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

function stripTrackingParams(url: URL): URL {
  const clean = new URL(url.toString());
  const dropPrefixes = ['utm_', 'pf_rd_', 'pd_rd_', 'ref', 'qid', 'sr', 'dib', 'sprefix', 'crid', 'keywords'];
  for (const key of Array.from(clean.searchParams.keys())) {
    const lower = key.toLowerCase();
    if (dropPrefixes.some((p) => lower === p || lower.startsWith(p))) {
      clean.searchParams.delete(key);
    }
  }
  return clean;
}

function buildCompactTextForAi(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titlePart = titleMatch?.[1] ? `Page Title: ${decodeHtmlEntities(titleMatch[1])}\n` : '';

  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

  const text = decodeHtmlEntities(stripped);
  return `${titlePart}${text}`.slice(0, 3800);
}

export async function extractProductWithWorkersAi(
  ai: WorkersAiBinding,
  html: string,
  urlStr: string,
  fallback: UrlPreviewResult
): Promise<UrlPreviewResult> {
  const excerpt = buildCompactTextForAi(html);
  if (excerpt.length < 80) {
    return fallback;
  }

  try {
    const result = await ai.run(WORKERS_AI_MODEL, {
      temperature: 0,
      max_tokens: 220,
      messages: [
        {
          role: 'system',
          content:
            'You extract e-commerce product details strictly from provided webpage text. Return ONLY a single JSON object with keys: "title" (string or null), "price" (number or null — the current selling price ONLY, never crossed-out MRP, never EMI/monthly installment, never discount amount), "currency" ("INR"|"USD"|"GBP"|"EUR"|null), "inStock" (boolean). If the page is a CAPTCHA, login wall, or has no explicit current selling price in the text, set "price" to null. Never guess or invent numbers.',
        },
        {
          role: 'user',
          content: `URL: ${urlStr}\nStore: ${fallback.platformLabel}\n\nWebpage Text:\n${excerpt}`,
        },
      ],
    });

    const rawText =
      typeof result === 'object' && result !== null && 'response' in result && typeof result.response === 'string'
        ? result.response
        : '';

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;

    const parsed = JSON.parse(jsonMatch[0]) as {
      title?: unknown;
      price?: unknown;
      currency?: unknown;
      inStock?: unknown;
    };

    const aiPrice = parseEdgePriceNumber(
      typeof parsed.price === 'number' || typeof parsed.price === 'string' ? parsed.price : null
    );
    if (aiPrice === null) {
      return fallback;
    }

    const aiTitle =
      typeof parsed.title === 'string' && parsed.title.trim().length >= 3
        ? parsed.title.trim().slice(0, 180)
        : fallback.title;

    const aiCurrency = detectCurrency(
      typeof parsed.currency === 'string' ? parsed.currency : undefined,
      fallback.currency
    );

    return {
      ...fallback,
      title: aiTitle,
      price: aiPrice,
      currency: aiCurrency,
      inStock: typeof parsed.inStock === 'boolean' ? parsed.inStock : fallback.inStock,
      fetchStatus: 'extracted',
      note: `Live price extracted from ${fallback.platformLabel} via Cloudflare Workers AI.`,
    };
  } catch {
    return fallback;
  }
}

async function fetchEdgeHtmlSafely(
  initialUrl: URL,
  profile: 'desktop' | 'mobile' = 'desktop'
): Promise<{ html: string; finalUrl: string } | null> {
  let currentUrl = initialUrl;

  const userAgent =
    profile === 'mobile'
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(currentUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Dest': 'document',
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return null;
        const nextUrl = new URL(location, currentUrl);
        currentUrl = validateEdgePublicUrl(nextUrl.toString());
        continue;
      }

      if (!res.ok) return null;
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        return null;
      }

      const text = await res.text();
      return { html: text.slice(0, MAX_HTML_BYTES), finalUrl: currentUrl.toString() };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

export async function previewProductUrlEdge(
  rawUrl: string,
  ai?: WorkersAiBinding
): Promise<UrlPreviewResult> {
  const validated = validateEdgePublicUrl(rawUrl);
  const urlStr = validated.toString();
  const { platform, platformLabel, currency } = detectPlatform(urlStr);

  // Attempt 1: Desktop browser fetch
  let fetched = await fetchEdgeHtmlSafely(validated, 'desktop');
  let parsed = fetched ? extractProductFromHtmlEdge(fetched.html, fetched.finalUrl) : null;

  // Attempt 2: Retry with stripped tracking params + mobile browser profile if blocked or failed
  if (!parsed || parsed.fetchStatus === 'blocked') {
    const cleanUrl = stripTrackingParams(validated);
    const mobileFetched = await fetchEdgeHtmlSafely(cleanUrl, 'mobile');
    if (mobileFetched) {
      const mobileParsed = extractProductFromHtmlEdge(mobileFetched.html, mobileFetched.finalUrl);
      if (mobileParsed.fetchStatus !== 'blocked') {
        fetched = mobileFetched;
        parsed = mobileParsed;
      }
    }
  }

  if (!fetched || !parsed) {
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

  // Fallback to Cloudflare Workers AI when HTML was fetched cleanly (not a CAPTCHA) but selectors missed the price
  if (ai && parsed.price === null && parsed.fetchStatus === 'partial') {
    return extractProductWithWorkersAi(ai, fetched.html, fetched.finalUrl, parsed);
  }

  return parsed;
}
