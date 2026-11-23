import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import {
  buildClearSessionCookieHeader,
  buildSessionCookieHeader,
  extractBearerToken,
  extractCookieValue,
  generateRandomHex,
  hashPassword,
  isCsrfSafeRequest,
  resolveConfiguredUsername,
  signSessionToken,
  verifyLoginCredentials,
  verifySessionToken,
} from './src/lib/authCrypto';
import {
  computeNextCheckAt,
  detectPlatform,
  evaluatePriceDrop,
  inferTitleFromUrl,
  isValidEmail,
  isValidTelegramChatId,
  sanitizeExternalUrl,
  validateCheckInterval,
} from './src/lib/priceUtils';
import type { AlertLogEntry, AlertSettings, CurrencyCode, TrackedProduct, TriggerMode } from './src/types/tracker';
import {
  dispatchMultiChannelAlert,
  getServerCapabilities,
  registerSseClient,
} from './server/notifier';
import { previewProductUrl, validatePublicShoppingUrl } from './server/scraper';
import { trackerStore } from './server/store';

const EPHEMERAL_SESSION_SECRET = generateRandomHex(32);
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const failedLoginBuckets = new Map<string, number[]>();

function getSessionSecret(): string {
  return process.env.AUTH_SESSION_SECRET?.trim() || EPHEMERAL_SESSION_SECRET;
}

function getEnvAuthConfig() {
  return {
    username: process.env.AUTH_USERNAME,
    password: process.env.AUTH_PASSWORD,
    passwordHash: process.env.AUTH_PASSWORD_HASH,
  };
}

const CHECK_CONCURRENCY = 4;

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map((item) => worker(item)));
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      }
    }
  }
  return results;
}

function checkLoginRateLimit(ipKey: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const recent = (failedLoginBuckets.get(ipKey) || []).filter((ts) => now - ts < LOGIN_WINDOW_MS);
  if (recent.length >= MAX_LOGIN_FAILURES) {
    const oldest = recent[0];
    const retryAfterSec = Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (now - oldest)) / 1000));
    failedLoginBuckets.set(ipKey, recent);
    return { allowed: false, retryAfterSec };
  }
  failedLoginBuckets.set(ipKey, recent);
  return { allowed: true, retryAfterSec: 0 };
}

function recordFailedLogin(ipKey: string): void {
  const now = Date.now();
  const recent = (failedLoginBuckets.get(ipKey) || []).filter((ts) => now - ts < LOGIN_WINDOW_MS);
  recent.push(now);
  failedLoginBuckets.set(ipKey, recent);
}

function clearFailedLogins(ipKey: string): void {
  failedLoginBuckets.delete(ipKey);
}

const PORT = 3000;
const VALID_CURRENCIES: CurrencyCode[] = ['INR', 'USD', 'GBP', 'EUR'];
const VALID_TRIGGER_MODES: TriggerMode[] = ['any_drop', 'percent_drop', 'target_price'];

async function executeProductCheck(product: TrackedProduct): Promise<{
  product: TrackedProduct;
  alert: AlertLogEntry | null;
}> {
  const nowIso = new Date().toISOString();
  const settings = trackerStore.getSettings();

  let preview;
  try {
    preview = await previewProductUrl(product.url);
  } catch (err) {
    const updated = trackerStore.updateProduct(product.id, (curr) => ({
      ...curr,
      lastCheckedAt: nowIso,
      nextCheckAt: computeNextCheckAt(nowIso, curr.checkIntervalHours),
      lastCheckStatus: 'error',
      lastCheckNote: err instanceof Error ? err.message : 'Check failed.',
    }));
    return { product: updated || product, alert: null };
  }

  if (preview.price === null) {
    const updated = trackerStore.updateProduct(product.id, (curr) => ({
      ...curr,
      lastCheckedAt: nowIso,
      nextCheckAt: computeNextCheckAt(nowIso, curr.checkIntervalHours),
      lastCheckStatus: 'blocked',
      lastCheckNote: preview.note,
    }));
    return { product: updated || product, alert: null };
  }

  return recordObservedPrice(product, preview.price, 'live', preview.note, preview.inStock);
}

async function recordObservedPrice(
  product: TrackedProduct,
  newPrice: number,
  source: 'live' | 'manual',
  note: string,
  inStock: boolean = true
): Promise<{ product: TrackedProduct; alert: AlertLogEntry | null }> {
  const nowIso = new Date().toISOString();
  const settings = trackerStore.getSettings();
  const previousPrice = product.currentPrice;
  const evaluation = evaluatePriceDrop(previousPrice, newPrice, product.targetPrice, settings);

  const updated = trackerStore.updateProduct(product.id, (curr) => {
    const nextHistory = [
      ...curr.history,
      { timestamp: nowIso, price: newPrice, source },
    ].slice(-90);
    return {
      ...curr,
      currentPrice: newPrice,
      lowestPrice: Math.min(curr.lowestPrice, newPrice),
      highestPrice: Math.max(curr.highestPrice, newPrice),
      inStock,
      lastCheckedAt: nowIso,
      nextCheckAt: computeNextCheckAt(nowIso, curr.checkIntervalHours),
      lastCheckStatus: 'ok',
      lastCheckNote: note,
      history: nextHistory,
    };
  });

  let alert: AlertLogEntry | null = null;
  if (evaluation.shouldNotify && updated) {
    alert = await dispatchMultiChannelAlert(settings, {
      type: 'price_drop',
      productId: updated.id,
      productTitle: updated.title,
      productUrl: updated.url,
      platformLabel: updated.platformLabel,
      currency: updated.currency,
      previousPrice,
      newPrice,
      dropAmount: evaluation.dropAmount,
      dropPercent: evaluation.dropPercent,
    });
    trackerStore.appendAlert(alert);
  }

  return { product: updated || product, alert };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  function isHttpsRequest(req: express.Request): boolean {
    const forwardedProto = (req.header('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
    return req.secure || forwardedProto === 'https';
  }

  async function authenticateRequest(req: express.Request) {
    const bearer = extractBearerToken(req.header('authorization'));
    const token = bearer || extractCookieValue(req.header('cookie'));
    if (!token) return null;
    const claims = await verifySessionToken(token, getSessionSecret());
    if (!claims) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (trackerStore.isTokenRevoked(claims.jti, nowSec)) return null;
    const configuredUser = resolveConfiguredUsername(
      getEnvAuthConfig(),
      trackerStore.getAuthCredentials()
    );
    if (!configuredUser || claims.sub !== configuredUser) return null;
    return { claims, hasBearerAuth: Boolean(bearer) };
  }

  // Auth status endpoint (public — reveals no secrets or watchlist data)
  app.get('/api/auth/status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const configuredUser = resolveConfiguredUsername(
      getEnvAuthConfig(),
      trackerStore.getAuthCredentials()
    );
    const auth = await authenticateRequest(req);
    res.json({
      configured: Boolean(configuredUser),
      authenticated: Boolean(auth),
      username: auth ? auth.claims.sub : null,
    });
  });

  // One-time setup route — strictly disabled once credentials exist in env or DB
  app.post('/api/auth/setup', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const configuredUser = resolveConfiguredUsername(
      getEnvAuthConfig(),
      trackerStore.getAuthCredentials()
    );
    if (configuredUser) {
      res.status(403).json({ error: 'Account is already configured. Please sign in.' });
      return;
    }

    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (username.length < 3 || username.length > 64) {
      res.status(400).json({ error: 'Username must be between 3 and 64 characters.' });
      return;
    }
    if (password.length < 8 || password.length > 128) {
      res.status(400).json({ error: 'Password must be between 8 and 128 characters.' });
      return;
    }

    const passwordHash = await hashPassword(password);
    trackerStore.setAuthCredentials({
      username,
      passwordHash,
      updatedAt: new Date().toISOString(),
    });

    const { token } = await signSessionToken(username, getSessionSecret());
    res.setHeader(
      'Set-Cookie',
      buildSessionCookieHeader(token, { isHttps: isHttpsRequest(req) })
    );
    res.status(201).json({ token, username });
  });

  // Login endpoint with brute-force rate limiting and constant-time credential verification
  app.post('/api/auth/login', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const ipKey = req.ip || req.socket.remoteAddress || 'unknown';
    const limit = checkLoginRateLimit(ipKey);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSec));
      res.status(429).json({ error: 'Too many failed sign-in attempts. Please wait and try again.' });
      return;
    }

    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const result = await verifyLoginCredentials(
      username,
      password,
      getEnvAuthConfig(),
      trackerStore.getAuthCredentials()
    );

    if (!result.valid || !result.username) {
      recordFailedLogin(ipKey);
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }

    clearFailedLogins(ipKey);
    const { token } = await signSessionToken(result.username, getSessionSecret());
    res.setHeader(
      'Set-Cookie',
      buildSessionCookieHeader(token, { isHttps: isHttpsRequest(req) })
    );
    res.json({ token, username: result.username });
  });

  // Logout endpoint — immediately revokes current session token server-side and clears cookie
  app.post('/api/auth/logout', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const auth = await authenticateRequest(req);
    if (auth) {
      const csrfOk = isCsrfSafeRequest({
        method: req.method,
        hasBearerAuth: auth.hasBearerAuth,
        origin: req.header('origin'),
        host: req.header('host'),
        forwardedHost: req.header('x-forwarded-host'),
        requestedWith: req.header('x-requested-with'),
      });
      if (!csrfOk) {
        res.status(403).json({ error: 'Cross-site request rejected.' });
        return;
      }
      const nowSec = Math.floor(Date.now() / 1000);
      trackerStore.revokeToken(auth.claims.jti, auth.claims.exp, nowSec);
    }
    res.setHeader('Set-Cookie', buildClearSessionCookieHeader({ isHttps: isHttpsRequest(req) }));
    res.json({ loggedOut: true });
  });

  // Protect every other /api/* route behind verified server-side auth + CSRF check
  app.use('/api', async (req, res, next) => {
    if (req.path.startsWith('/auth/')) {
      next();
      return;
    }
    const auth = await authenticateRequest(req);
    if (!auth) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const csrfOk = isCsrfSafeRequest({
      method: req.method,
      hasBearerAuth: auth.hasBearerAuth,
      origin: req.header('origin'),
      host: req.header('host'),
      forwardedHost: req.header('x-forwarded-host'),
      requestedWith: req.header('x-requested-with'),
    });
    if (!csrfOk) {
      res.status(403).json({ error: 'Cross-site request rejected.' });
      return;
    }
    next();
  });

  // SSE stream for instant browser push alerts
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(': connected\n\n');
    registerSseClient(res);

    const heartbeat = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
    });
  });

  // Initial state bootstrap
  app.get('/api/bootstrap', (_req, res) => {
    const state = trackerStore.getState();
    res.json({
      products: state.products,
      settings: state.settings,
      alerts: state.alerts,
      capabilities: getServerCapabilities(),
    });
  });

  // Preview product URL (SSRF-validated scrape)
  app.post('/api/products/preview', async (req, res) => {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (!rawUrl) {
      res.status(400).json({ error: 'Please paste a product URL first.' });
      return;
    }

    try {
      const preview = await previewProductUrl(rawUrl);
      res.json(preview);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to validate product URL.',
      });
    }
  });

  // Add a product to the watchlist
  app.post('/api/products', async (req, res) => {
    try {
      const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      if (!rawUrl) {
        res.status(400).json({ error: 'Product URL is required.' });
        return;
      }

      const validatedUrl = await validatePublicShoppingUrl(rawUrl);
      const urlStr = validatedUrl.toString();
      const detected = detectPlatform(urlStr);

      const title =
        typeof req.body?.title === 'string' && req.body.title.trim().length >= 2
          ? req.body.title.trim().slice(0, 180)
          : inferTitleFromUrl(urlStr);

      const currentPrice = Number(req.body?.currentPrice);
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        res.status(400).json({ error: 'Enter a valid current price greater than 0.' });
        return;
      }

      const targetRaw = req.body?.targetPrice;
      let targetPrice: number | null = null;
      if (targetRaw !== null && targetRaw !== undefined && targetRaw !== '') {
        const parsedTarget = Number(targetRaw);
        if (!Number.isFinite(parsedTarget) || parsedTarget <= 0) {
          res.status(400).json({ error: 'Target price must be greater than 0.' });
          return;
        }
        targetPrice = Number(parsedTarget.toFixed(2));
      }

      const requestedInterval =
        req.body?.checkIntervalHours !== undefined
          ? Number(req.body.checkIntervalHours)
          : trackerStore.getSettings().defaultCheckIntervalHours;
      const intervalCheck = validateCheckInterval(requestedInterval);
      if (!intervalCheck.valid) {
        res.status(400).json({ error: intervalCheck.error });
        return;
      }

      const currency: CurrencyCode = VALID_CURRENCIES.includes(req.body?.currency)
        ? req.body.currency
        : detected.currency;

      const imageUrl = sanitizeExternalUrl(req.body?.imageUrl);
      const nowIso = new Date().toISOString();

      const product: TrackedProduct = {
        id: `prod-${crypto.randomUUID().slice(0, 8)}`,
        url: urlStr,
        title,
        platform: detected.platform,
        platformLabel: detected.platformLabel,
        currency,
        imageUrl,
        currentPrice: Number(currentPrice.toFixed(2)),
        initialPrice: Number(currentPrice.toFixed(2)),
        lowestPrice: Number(currentPrice.toFixed(2)),
        highestPrice: Number(currentPrice.toFixed(2)),
        targetPrice,
        checkIntervalHours: intervalCheck.value,
        lastCheckedAt: nowIso,
        nextCheckAt: computeNextCheckAt(nowIso, intervalCheck.value),
        lastCheckStatus: 'ok',
        lastCheckNote: 'Tracking started.',
        inStock: true,
        createdAt: nowIso,
        history: [{ timestamp: nowIso, price: Number(currentPrice.toFixed(2)), source: 'live' }],
      };

      trackerStore.addProduct(product);
      res.status(201).json({ product });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to track product.',
      });
    }
  });

  // Update product target price, title, or check interval (>= 1h)
  app.patch('/api/products/:id', (req, res) => {
    const existing = trackerStore.getProductById(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Product not found.' });
      return;
    }

    let nextInterval = existing.checkIntervalHours;
    if (req.body?.checkIntervalHours !== undefined) {
      const intervalCheck = validateCheckInterval(Number(req.body.checkIntervalHours));
      if (!intervalCheck.valid) {
        res.status(400).json({ error: intervalCheck.error });
        return;
      }
      nextInterval = intervalCheck.value;
    }

    let nextTarget = existing.targetPrice;
    if (req.body?.targetPrice !== undefined) {
      if (req.body.targetPrice === null || req.body.targetPrice === '') {
        nextTarget = null;
      } else {
        const parsed = Number(req.body.targetPrice);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          res.status(400).json({ error: 'Target price must be greater than 0.' });
          return;
        }
        nextTarget = Number(parsed.toFixed(2));
      }
    }

    const nextTitle =
      typeof req.body?.title === 'string' && req.body.title.trim().length >= 2
        ? req.body.title.trim().slice(0, 180)
        : existing.title;

    const updated = trackerStore.updateProduct(existing.id, (curr) => ({
      ...curr,
      title: nextTitle,
      targetPrice: nextTarget,
      checkIntervalHours: nextInterval,
      nextCheckAt: computeNextCheckAt(curr.lastCheckedAt, nextInterval),
    }));

    res.json({ product: updated });
  });

  // Delete product
  app.delete('/api/products/:id', (req, res) => {
    const deleted = trackerStore.deleteProduct(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Product not found.' });
      return;
    }
    res.json({ deleted: true });
  });

  // Trigger an immediate live check for a single product
  app.post('/api/products/:id/check', async (req, res) => {
    const product = trackerStore.getProductById(req.params.id);
    if (!product) {
      res.status(404).json({ error: 'Product not found.' });
      return;
    }

    const result = await executeProductCheck(product);
    res.json(result);
  });

  // Record an observed price manually (also triggers instant drop alerts when lower)
  app.post('/api/products/:id/record-price', async (req, res) => {
    const product = trackerStore.getProductById(req.params.id);
    if (!product) {
      res.status(404).json({ error: 'Product not found.' });
      return;
    }

    const newPrice = Number(req.body?.price);
    if (!Number.isFinite(newPrice) || newPrice <= 0) {
      res.status(400).json({ error: 'Enter a valid price greater than 0.' });
      return;
    }

    const result = await recordObservedPrice(
      product,
      Number(newPrice.toFixed(2)),
      'manual',
      'Price updated manually.'
    );
    res.json(result);
  });

  // Run scheduled check cycle for all products now
  app.post('/api/schedule/run-now', async (_req, res) => {
    const products = trackerStore.getProducts();
    const outcomes = await runWithConcurrency(products, CHECK_CONCURRENCY, (product) =>
      executeProductCheck(product)
    );
    const alerts = outcomes
      .map((o) => o.alert)
      .filter((a): a is AlertLogEntry => a !== null);

    res.json({
      checkedCount: outcomes.length,
      products: trackerStore.getProducts(),
      alerts,
    });
  });

  // Save alert settings & global default interval (>= 1h)
  app.put('/api/settings', (req, res) => {
    const current = trackerStore.getSettings();
    const body = req.body || {};

    const intervalInput =
      body.defaultCheckIntervalHours !== undefined
        ? Number(body.defaultCheckIntervalHours)
        : current.defaultCheckIntervalHours;
    const intervalCheck = validateCheckInterval(intervalInput);
    if (!intervalCheck.valid) {
      res.status(400).json({ error: intervalCheck.error });
      return;
    }

    const triggerMode: TriggerMode = VALID_TRIGGER_MODES.includes(body.triggerMode)
      ? body.triggerMode
      : current.triggerMode;

    const minDropPercent =
      body.minDropPercent !== undefined ? Number(body.minDropPercent) : current.minDropPercent;
    if (!Number.isFinite(minDropPercent) || minDropPercent < 1 || minDropPercent > 95) {
      res.status(400).json({ error: 'Minimum drop percentage must be between 1% and 95%.' });
      return;
    }

    const emailEnabled =
      typeof body.email?.enabled === 'boolean' ? body.email.enabled : current.email.enabled;
    const emailAddress =
      typeof body.email?.address === 'string' ? body.email.address.trim() : current.email.address;
    if (emailEnabled && !isValidEmail(emailAddress)) {
      res.status(400).json({ error: 'Please enter a valid recipient email address to enable Email alerts.' });
      return;
    }
    if (!emailEnabled && emailAddress && !isValidEmail(emailAddress)) {
      res.status(400).json({ error: 'Please enter a valid recipient email address.' });
      return;
    }

    const telegramEnabled =
      typeof body.telegram?.enabled === 'boolean'
        ? body.telegram.enabled
        : current.telegram.enabled;
    const telegramChatId =
      typeof body.telegram?.chatId === 'string'
        ? body.telegram.chatId.trim()
        : current.telegram.chatId;
    if (telegramEnabled && !isValidTelegramChatId(telegramChatId)) {
      res.status(400).json({
        error: 'Enter a valid numeric Telegram Chat ID (5 to 20 digits) to enable Telegram alerts.',
      });
      return;
    }
    if (!telegramEnabled && telegramChatId && !isValidTelegramChatId(telegramChatId)) {
      res.status(400).json({
        error: 'Telegram Chat ID must be a numeric ID (5 to 20 digits, e.g. 123456789).',
      });
      return;
    }

    const pushEnabled =
      typeof body.push?.enabled === 'boolean' ? body.push.enabled : current.push.enabled;

    const nextSettings: AlertSettings = {
      defaultCheckIntervalHours: intervalCheck.value,
      triggerMode,
      minDropPercent: Math.round(minDropPercent),
      email: {
        enabled: emailEnabled,
        address: emailAddress,
      },
      telegram: {
        enabled: telegramEnabled,
        chatId: telegramChatId,
      },
      push: {
        enabled: pushEnabled,
      },
    };

    const applyToAll = Boolean(body.applyIntervalToAll);
    const saved = trackerStore.updateSettings(nextSettings, applyToAll);
    res.json({
      settings: saved,
      products: trackerStore.getProducts(),
      capabilities: getServerCapabilities(),
    });
  });

  // Send a test notification (all channels or one specific channel)
  app.post('/api/notifications/test', async (req, res) => {
    const channelRaw = req.body?.channel;
    const onlyChannel =
      channelRaw === 'email' || channelRaw === 'telegram' || channelRaw === 'push'
        ? channelRaw
        : undefined;

    const settings = trackerStore.getSettings();
    const alert = await dispatchMultiChannelAlert(settings, {
      type: 'test',
      productId: null,
      productTitle: 'PricePulse Alert Verification',
      productUrl: null,
      platformLabel: 'System',
      currency: 'INR',
      previousPrice: null,
      newPrice: null,
      dropAmount: null,
      dropPercent: null,
      onlyChannel,
      customMessage: onlyChannel
        ? `Test ${onlyChannel} notification sent from PricePulse Alert Setup.`
        : 'Multi-channel test notification dispatched across your enabled channels.',
    });

    trackerStore.appendAlert(alert);
    res.json({ alert });
  });

  // Delete a single alert log entry
  app.delete('/api/alerts/:id', (req, res) => {
    const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!id) {
      res.status(400).json({ error: 'Alert ID is required.' });
      return;
    }
    const deleted = trackerStore.deleteAlert(id);
    if (!deleted) {
      res.status(404).json({ error: 'Alert log not found.' });
      return;
    }
    res.json({ deleted: true });
  });

  // Clear all alert log entries
  app.delete('/api/alerts', (_req, res) => {
    const clearedCount = trackerStore.clearAlerts();
    res.json({ cleared: true, clearedCount });
  });

  // Background interval scheduler: checks due products every 60 seconds
  let schedulerRunning = false;
  setInterval(async () => {
    if (schedulerRunning) return;
    schedulerRunning = true;
    try {
      const nowMs = Date.now();
      const dueProducts = trackerStore
        .getProducts()
        .filter((p) => Date.parse(p.nextCheckAt) <= nowMs);
      await runWithConcurrency(dueProducts, CHECK_CONCURRENCY, (product) =>
        executeProductCheck(product)
      );
    } finally {
      schedulerRunning = false;
    }
  }, 60_000);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PricePulse server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
