import { Hono } from 'hono';
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
  timingSafeEqualStrings,
  verifyLoginCredentials,
  verifySessionToken,
} from '../src/lib/authCrypto';
import {
  computeNextCheckAt,
  detectPlatform,
  evaluatePriceDrop,
  inferTitleFromUrl,
  isValidEmail,
  isValidTelegramChatId,
  sanitizeExternalUrl,
  validateCheckInterval,
} from '../src/lib/priceUtils';
import { injectInitialStateIntoHtml } from '../src/lib/initialState';
import { resolveVapidConfig, validatePushSubscriptionInput } from '../src/lib/webPush';
import type {
  AlertLogEntry,
  AlertSettings,
  BootstrapResponse,
  CurrencyCode,
  TrackedProduct,
  TriggerMode,
} from '../src/types/tracker';
import {
  clearAlertsD1,
  countPushSubscriptionsD1,
  deleteAlertD1,
  deleteProductD1,
  deletePushSubscriptionD1,
  ensureD1Schema,
  getAlertsD1,
  getAllProductsD1,
  getAuthCredentialsD1,
  getProductByIdD1,
  getSettingsD1,
  insertAlertD1,
  insertProductD1,
  isTokenRevokedD1,
  revokeTokenD1,
  saveAuthCredentialsD1,
  saveSettingsD1,
  updateProductCheckStatusD1,
  updateProductMetaD1,
  updateProductPriceD1,
  upsertPushSubscriptionD1,
} from './db';
import { dispatchEdgeAlert, getWorkerCapabilities } from './notifier';
import { previewProductUrlEdge, validateEdgePublicUrl } from './scraper';
import type { WorkerEnv, WorkerExecutionContext, WorkerScheduledEvent } from './types';

let ephemeralEdgeSessionSecret: string | null = null;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const edgeFailedLogins = new Map<string, number[]>();
const EDGE_CHECK_CONCURRENCY = 4;

async function runEdgeWithConcurrency<T, R>(
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

function getEdgeSessionSecret(env: WorkerEnv): string {
  const configured = env.AUTH_SESSION_SECRET?.trim();
  if (configured) return configured;
  if (!ephemeralEdgeSessionSecret) {
    ephemeralEdgeSessionSecret = generateRandomHex(32);
  }
  return ephemeralEdgeSessionSecret;
}

function getEdgeEnvAuth(env: WorkerEnv) {
  return {
    username: env.AUTH_USERNAME,
    password: env.AUTH_PASSWORD,
    passwordHash: env.AUTH_PASSWORD_HASH,
  };
}

function checkEdgeRateLimit(ipKey: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const recent = (edgeFailedLogins.get(ipKey) || []).filter((ts) => now - ts < LOGIN_WINDOW_MS);
  if (recent.length >= MAX_LOGIN_FAILURES) {
    const oldest = recent[0];
    const retryAfterSec = Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (now - oldest)) / 1000));
    edgeFailedLogins.set(ipKey, recent);
    return { allowed: false, retryAfterSec };
  }
  edgeFailedLogins.set(ipKey, recent);
  return { allowed: true, retryAfterSec: 0 };
}

function recordEdgeFailedLogin(ipKey: string): void {
  const now = Date.now();
  const recent = (edgeFailedLogins.get(ipKey) || []).filter((ts) => now - ts < LOGIN_WINDOW_MS);
  recent.push(now);
  edgeFailedLogins.set(ipKey, recent);
}

function clearEdgeFailedLogins(ipKey: string): void {
  edgeFailedLogins.delete(ipKey);
}

function isHttpsEdgeRequest(reqUrl: string, forwardedProto: string | undefined): boolean {
  const proto = (forwardedProto || '').split(',')[0].trim().toLowerCase();
  if (proto === 'https') return true;
  try {
    return new URL(reqUrl).protocol === 'https:';
  } catch {
    return true;
  }
}

async function authenticateEdgeRequest(
  env: WorkerEnv,
  authHeader: string | undefined,
  cookieHeader: string | undefined
) {
  const bearer = extractBearerToken(authHeader);
  const token = bearer || extractCookieValue(cookieHeader);
  if (!token) return null;
  const claims = await verifySessionToken(token, getEdgeSessionSecret(env));
  if (!claims) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  const revoked = await isTokenRevokedD1(env.DB, claims.jti, nowSec);
  if (revoked) return null;
  const dbAuth = await getAuthCredentialsD1(env.DB);
  const configuredUser = resolveConfiguredUsername(getEdgeEnvAuth(env), dbAuth);
  if (!configuredUser || claims.sub !== configuredUser) return null;
  return { claims, hasBearerAuth: Boolean(bearer) };
}

const VALID_CURRENCIES: CurrencyCode[] = ['INR', 'USD', 'GBP', 'EUR'];
const VALID_TRIGGER_MODES: TriggerMode[] = ['any_drop', 'percent_drop', 'target_price'];

async function recordObservedPriceEdge(
  env: WorkerEnv,
  product: TrackedProduct,
  newPrice: number,
  source: 'live' | 'manual',
  note: string,
  inStock: boolean = true
): Promise<{ product: TrackedProduct; alert: AlertLogEntry | null }> {
  const nowIso = new Date().toISOString();
  const settings = await getSettingsD1(env.DB);
  const previousPrice = product.currentPrice;
  const evaluation = evaluatePriceDrop(previousPrice, newPrice, product.targetPrice, settings);

  const updated =
    (await updateProductPriceD1(env.DB, product, {
      newPrice,
      source,
      nowIso,
      note,
      inStock,
    })) || product;

  let alert: AlertLogEntry | null = null;
  if (evaluation.shouldNotify) {
    alert = await dispatchEdgeAlert(env, settings, {
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
    await insertAlertD1(env.DB, alert);
  }

  return { product: updated, alert };
}

async function executeProductCheckEdge(
  env: WorkerEnv,
  product: TrackedProduct
): Promise<{ product: TrackedProduct; alert: AlertLogEntry | null }> {
  const nowIso = new Date().toISOString();
  let preview;
  try {
    preview = await previewProductUrlEdge(product.url, env.AI);
  } catch (err) {
    const updated =
      (await updateProductCheckStatusD1(env.DB, product.id, {
        lastCheckedAt: nowIso,
        nextCheckAt: computeNextCheckAt(nowIso, product.checkIntervalHours),
        status: 'error',
        note: err instanceof Error ? err.message : 'Check failed.',
      })) || product;
    return { product: updated, alert: null };
  }

  if (preview.price === null) {
    const updated =
      (await updateProductCheckStatusD1(env.DB, product.id, {
        lastCheckedAt: nowIso,
        nextCheckAt: computeNextCheckAt(nowIso, product.checkIntervalHours),
        status: 'blocked',
        note: preview.note,
      })) || product;
    return { product: updated, alert: null };
  }

  return recordObservedPriceEdge(env, product, preview.price, 'live', preview.note, preview.inStock);
}

async function buildWorkerBootstrap(env: WorkerEnv): Promise<BootstrapResponse> {
  const [products, settings, alerts, pushSubscriptionCount] = await Promise.all([
    getAllProductsD1(env.DB),
    getSettingsD1(env.DB),
    getAlertsD1(env.DB),
    countPushSubscriptionsD1(env.DB),
  ]);
  return {
    products,
    settings,
    alerts,
    capabilities: getWorkerCapabilities(env, pushSubscriptionCount),
  };
}

const app = new Hono<{ Bindings: WorkerEnv }>();

app.use('/api/*', async (c, next) => {
  await ensureD1Schema(c.env.DB);
  const reqPath = new URL(c.req.url).pathname;
  if (reqPath.startsWith('/api/auth/') || reqPath === '/api/schedule/run-due') {
    await next();
    return;
  }
  const auth = await authenticateEdgeRequest(
    c.env,
    c.req.header('authorization'),
    c.req.header('cookie')
  );
  if (!auth) {
    return c.json({ error: 'Authentication required.' }, 401);
  }
  const csrfOk = isCsrfSafeRequest({
    method: c.req.method,
    hasBearerAuth: auth.hasBearerAuth,
    origin: c.req.header('origin'),
    host: c.req.header('host'),
    forwardedHost: c.req.header('x-forwarded-host'),
    requestedWith: c.req.header('x-requested-with'),
  });
  if (!csrfOk) {
    return c.json({ error: 'Cross-site request rejected.' }, 403);
  }
  await next();
});

app.get('/api/auth/status', async (c) => {
  c.header('Cache-Control', 'no-store');
  const dbAuth = await getAuthCredentialsD1(c.env.DB);
  const configuredUser = resolveConfiguredUsername(getEdgeEnvAuth(c.env), dbAuth);
  const auth = await authenticateEdgeRequest(
    c.env,
    c.req.header('authorization'),
    c.req.header('cookie')
  );
  const includeBootstrap = c.req.query('includeBootstrap') === '1';
  const bootstrap = auth && includeBootstrap ? await buildWorkerBootstrap(c.env) : undefined;
  return c.json({
    configured: Boolean(configuredUser),
    authenticated: Boolean(auth),
    username: auth ? auth.claims.sub : null,
    ...(includeBootstrap ? { bootstrap: bootstrap ?? null } : {}),
  });
});

app.post('/api/auth/setup', async (c) => {
  c.header('Cache-Control', 'no-store');
  const dbAuth = await getAuthCredentialsD1(c.env.DB);
  const configuredUser = resolveConfiguredUsername(getEdgeEnvAuth(c.env), dbAuth);
  if (configuredUser) {
    return c.json({ error: 'Account is already configured. Please sign in.' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (username.length < 3 || username.length > 64) {
    return c.json({ error: 'Username must be between 3 and 64 characters.' }, 400);
  }
  if (password.length < 8 || password.length > 128) {
    return c.json({ error: 'Password must be between 8 and 128 characters.' }, 400);
  }

  const passwordHash = await hashPassword(password);
  await saveAuthCredentialsD1(c.env.DB, {
    username,
    passwordHash,
    updatedAt: new Date().toISOString(),
  });

  const { token } = await signSessionToken(username, getEdgeSessionSecret(c.env));
  c.header(
    'Set-Cookie',
    buildSessionCookieHeader(token, {
      isHttps: isHttpsEdgeRequest(c.req.url, c.req.header('x-forwarded-proto')),
    })
  );
  const bootstrap = await buildWorkerBootstrap(c.env);
  return c.json({ token, username, bootstrap }, 201);
});

app.post('/api/auth/login', async (c) => {
  c.header('Cache-Control', 'no-store');
  const ipKey = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
  const limit = checkEdgeRateLimit(ipKey);
  if (!limit.allowed) {
    c.header('Retry-After', String(limit.retryAfterSec));
    return c.json(
      { error: 'Too many failed sign-in attempts. Please wait and try again.' },
      429
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const username = typeof body?.username === 'string' ? body.username : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const dbAuth = await getAuthCredentialsD1(c.env.DB);
  const result = await verifyLoginCredentials(
    username,
    password,
    getEdgeEnvAuth(c.env),
    dbAuth
  );

  if (!result.valid || !result.username) {
    recordEdgeFailedLogin(ipKey);
    return c.json({ error: 'Invalid username or password.' }, 401);
  }

  clearEdgeFailedLogins(ipKey);
  const { token } = await signSessionToken(result.username, getEdgeSessionSecret(c.env));
  c.header(
    'Set-Cookie',
    buildSessionCookieHeader(token, {
      isHttps: isHttpsEdgeRequest(c.req.url, c.req.header('x-forwarded-proto')),
    })
  );
  const bootstrap = await buildWorkerBootstrap(c.env);
  return c.json({ token, username: result.username, bootstrap });
});

app.post('/api/auth/logout', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = await authenticateEdgeRequest(
    c.env,
    c.req.header('authorization'),
    c.req.header('cookie')
  );
  if (auth) {
    const csrfOk = isCsrfSafeRequest({
      method: c.req.method,
      hasBearerAuth: auth.hasBearerAuth,
      origin: c.req.header('origin'),
      host: c.req.header('host'),
      forwardedHost: c.req.header('x-forwarded-host'),
      requestedWith: c.req.header('x-requested-with'),
    });
    if (!csrfOk) {
      return c.json({ error: 'Cross-site request rejected.' }, 403);
    }
    const nowSec = Math.floor(Date.now() / 1000);
    await revokeTokenD1(c.env.DB, auth.claims.jti, auth.claims.exp, nowSec);
  }
  c.header(
    'Set-Cookie',
    buildClearSessionCookieHeader({
      isHttps: isHttpsEdgeRequest(c.req.url, c.req.header('x-forwarded-proto')),
    })
  );
  return c.json({ loggedOut: true });
});

app.get('/api/bootstrap', async (c) => {
  c.header('Cache-Control', 'no-store');
  const bootstrap = await buildWorkerBootstrap(c.env);
  return c.json(bootstrap);
});

app.get('/api/events', () => {
  // Edge runtime returns a clean 204 so the frontend switches seamlessly to periodic polling
  return new Response(null, { status: 204 });
});

app.post('/api/products/preview', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const rawUrl = typeof body?.url === 'string' ? body.url.trim() : '';
  if (!rawUrl) {
    return c.json({ error: 'Please paste a product URL first.' }, 400);
  }
  try {
    const preview = await previewProductUrlEdge(rawUrl, c.env.AI);
    return c.json(preview);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Unable to validate product URL.' },
      400
    );
  }
});

app.post('/api/products', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const rawUrl = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!rawUrl) {
      return c.json({ error: 'Product URL is required.' }, 400);
    }

    const validatedUrl = validateEdgePublicUrl(rawUrl);
    const urlStr = validatedUrl.toString();
    const detected = detectPlatform(urlStr);

    const title =
      typeof body?.title === 'string' && body.title.trim().length >= 2
        ? body.title.trim().slice(0, 180)
        : inferTitleFromUrl(urlStr);

    const currentPrice = Number(body?.currentPrice);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      return c.json({ error: 'Enter a valid current price greater than 0.' }, 400);
    }

    let targetPrice: number | null = null;
    if (body?.targetPrice !== null && body?.targetPrice !== undefined && body?.targetPrice !== '') {
      const parsedTarget = Number(body.targetPrice);
      if (!Number.isFinite(parsedTarget) || parsedTarget <= 0) {
        return c.json({ error: 'Target price must be greater than 0.' }, 400);
      }
      targetPrice = Number(parsedTarget.toFixed(2));
    }

    const settings = await getSettingsD1(c.env.DB);
    const requestedInterval =
      body?.checkIntervalHours !== undefined
        ? Number(body.checkIntervalHours)
        : settings.defaultCheckIntervalHours;
    const intervalCheck = validateCheckInterval(requestedInterval);
    if (!intervalCheck.valid) {
      return c.json({ error: intervalCheck.error }, 400);
    }

    const currency: CurrencyCode = VALID_CURRENCIES.includes(body?.currency)
      ? body.currency
      : detected.currency;
    const imageUrl = sanitizeExternalUrl(body?.imageUrl);
    const nowIso = new Date().toISOString();
    const roundedPrice = Number(currentPrice.toFixed(2));

    const product: TrackedProduct = {
      id: `prod-${crypto.randomUUID().slice(0, 8)}`,
      url: urlStr,
      title,
      platform: detected.platform,
      platformLabel: detected.platformLabel,
      currency,
      imageUrl,
      currentPrice: roundedPrice,
      initialPrice: roundedPrice,
      lowestPrice: roundedPrice,
      highestPrice: roundedPrice,
      targetPrice,
      checkIntervalHours: intervalCheck.value,
      lastCheckedAt: nowIso,
      nextCheckAt: computeNextCheckAt(nowIso, intervalCheck.value),
      lastCheckStatus: 'ok',
      lastCheckNote: 'Tracking started.',
      inStock: true,
      createdAt: nowIso,
      history: [{ timestamp: nowIso, price: roundedPrice, source: 'live' }],
    };

    await insertProductD1(c.env.DB, product);
    return c.json({ product }, 201);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Failed to track product.' },
      400
    );
  }
});

app.patch('/api/products/:id', async (c) => {
  const existing = await getProductByIdD1(c.env.DB, c.req.param('id'));
  if (!existing) {
    return c.json({ error: 'Product not found.' }, 404);
  }

  const body = await c.req.json().catch(() => ({}));
  let nextInterval = existing.checkIntervalHours;
  if (body?.checkIntervalHours !== undefined) {
    const check = validateCheckInterval(Number(body.checkIntervalHours));
    if (!check.valid) return c.json({ error: check.error }, 400);
    nextInterval = check.value;
  }

  let nextTarget = existing.targetPrice;
  if (body?.targetPrice !== undefined) {
    if (body.targetPrice === null || body.targetPrice === '') {
      nextTarget = null;
    } else {
      const parsed = Number(body.targetPrice);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return c.json({ error: 'Target price must be greater than 0.' }, 400);
      }
      nextTarget = Number(parsed.toFixed(2));
    }
  }

  const nextTitle =
    typeof body?.title === 'string' && body.title.trim().length >= 2
      ? body.title.trim().slice(0, 180)
      : existing.title;

  const updated = await updateProductMetaD1(c.env.DB, existing.id, {
    title: nextTitle,
    targetPrice: nextTarget,
    checkIntervalHours: nextInterval,
    nextCheckAt: computeNextCheckAt(existing.lastCheckedAt, nextInterval),
  });

  return c.json({ product: updated });
});

app.delete('/api/products/:id', async (c) => {
  const deleted = await deleteProductD1(c.env.DB, c.req.param('id'));
  if (!deleted) return c.json({ error: 'Product not found.' }, 404);
  return c.json({ deleted: true });
});

app.post('/api/products/:id/check', async (c) => {
  const product = await getProductByIdD1(c.env.DB, c.req.param('id'));
  if (!product) return c.json({ error: 'Product not found.' }, 404);
  const result = await executeProductCheckEdge(c.env, product);
  return c.json(result);
});

app.post('/api/products/:id/record-price', async (c) => {
  const product = await getProductByIdD1(c.env.DB, c.req.param('id'));
  if (!product) return c.json({ error: 'Product not found.' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const newPrice = Number(body?.price);
  if (!Number.isFinite(newPrice) || newPrice <= 0) {
    return c.json({ error: 'Enter a valid price greater than 0.' }, 400);
  }
  const result = await recordObservedPriceEdge(
    c.env,
    product,
    Number(newPrice.toFixed(2)),
    'manual',
    'Price updated manually.'
  );
  return c.json(result);
});

app.post('/api/schedule/run-now', async (c) => {
  const products = await getAllProductsD1(c.env.DB);
  const outcomes = await runEdgeWithConcurrency(products, EDGE_CHECK_CONCURRENCY, (product) =>
    executeProductCheckEdge(c.env, product)
  );
  const alerts = outcomes
    .map((o) => o.alert)
    .filter((a): a is AlertLogEntry => a !== null);
  const refreshed = await getAllProductsD1(c.env.DB);
  return c.json({
    checkedCount: outcomes.length,
    products: refreshed,
    alerts,
  });
});

app.all('/api/schedule/run-due', async (c) => {
  const authHeader = c.req.header('authorization') || '';
  const bearer = extractBearerToken(authHeader);
  const requiredSecret = c.env.CRON_SECRET?.trim();
  let authorized = false;

  if (requiredSecret && bearer) {
    authorized = await timingSafeEqualStrings(bearer, requiredSecret);
  }
  if (!authorized) {
    const auth = await authenticateEdgeRequest(c.env, authHeader, c.req.header('cookie'));
    if (auth) {
      authorized = isCsrfSafeRequest({
        method: c.req.method,
        hasBearerAuth: auth.hasBearerAuth,
        origin: c.req.header('origin'),
        host: c.req.header('host'),
        forwardedHost: c.req.header('x-forwarded-host'),
        requestedWith: c.req.header('x-requested-with'),
      });
    }
  }
  if (!authorized) {
    return c.json({ error: 'Unauthorized cron trigger.' }, 401);
  }

  const nowMs = Date.now();
  const products = await getAllProductsD1(c.env.DB);
  const due = products.filter((p) => Date.parse(p.nextCheckAt) <= nowMs);
  const outcomes = await runEdgeWithConcurrency(due, EDGE_CHECK_CONCURRENCY, (product) =>
    executeProductCheckEdge(c.env, product)
  );
  const alerts = outcomes
    .map((o) => o.alert)
    .filter((a): a is AlertLogEntry => a !== null);

  return c.json({
    dueCount: due.length,
    alertsTriggered: alerts.length,
    checkedAt: new Date().toISOString(),
  });
});

app.put('/api/settings', async (c) => {
  const current = await getSettingsD1(c.env.DB);
  const body = await c.req.json().catch(() => ({}));

  const intervalInput =
    body.defaultCheckIntervalHours !== undefined
      ? Number(body.defaultCheckIntervalHours)
      : current.defaultCheckIntervalHours;
  const intervalCheck = validateCheckInterval(intervalInput);
  if (!intervalCheck.valid) return c.json({ error: intervalCheck.error }, 400);

  const triggerMode: TriggerMode = VALID_TRIGGER_MODES.includes(body.triggerMode)
    ? body.triggerMode
    : current.triggerMode;

  const minDropPercent =
    body.minDropPercent !== undefined ? Number(body.minDropPercent) : current.minDropPercent;
  if (!Number.isFinite(minDropPercent) || minDropPercent < 1 || minDropPercent > 95) {
    return c.json({ error: 'Minimum drop percentage must be between 1% and 95%.' }, 400);
  }

  const emailEnabled =
    typeof body.email?.enabled === 'boolean' ? body.email.enabled : current.email.enabled;
  const emailAddress =
    typeof body.email?.address === 'string' ? body.email.address.trim() : current.email.address;
  if (emailEnabled && !isValidEmail(emailAddress)) {
    return c.json(
      { error: 'Please enter a valid recipient email address to enable Email alerts.' },
      400
    );
  }
  if (!emailEnabled && emailAddress && !isValidEmail(emailAddress)) {
    return c.json({ error: 'Please enter a valid recipient email address.' }, 400);
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
    return c.json(
      {
        error:
          'Enter a valid numeric Telegram Chat ID (5 to 20 digits) to enable Telegram alerts.',
      },
      400
    );
  }
  if (!telegramEnabled && telegramChatId && !isValidTelegramChatId(telegramChatId)) {
    return c.json(
      { error: 'Telegram Chat ID must be a numeric ID (5 to 20 digits, e.g. 123456789).' },
      400
    );
  }

  const pushEnabled =
    typeof body.push?.enabled === 'boolean' ? body.push.enabled : current.push.enabled;

  const nextSettings: AlertSettings = {
    defaultCheckIntervalHours: intervalCheck.value,
    triggerMode,
    minDropPercent: Math.round(minDropPercent),
    email: { enabled: emailEnabled, address: emailAddress },
    telegram: { enabled: telegramEnabled, chatId: telegramChatId },
    push: { enabled: pushEnabled },
  };

  const saved = await saveSettingsD1(c.env.DB, nextSettings, Boolean(body.applyIntervalToAll));
  const [products, pushSubscriptionCount] = await Promise.all([
    getAllProductsD1(c.env.DB),
    countPushSubscriptionsD1(c.env.DB),
  ]);
  return c.json({
    settings: saved,
    products,
    capabilities: getWorkerCapabilities(c.env, pushSubscriptionCount),
  });
});

app.get('/api/push/config', async (c) => {
  const vapid = resolveVapidConfig(c.env);
  const subscriptionCount = await countPushSubscriptionsD1(c.env.DB);
  return c.json({
    configured: Boolean(vapid),
    vapidPublicKey: vapid ? vapid.publicKey : null,
    subscriptionCount,
  });
});

app.post('/api/push/subscribe', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validated = validatePushSubscriptionInput(body);
  if (!validated.valid) {
    return c.json({ error: validated.error }, 400);
  }
  const userAgent = (c.req.header('user-agent') || '').slice(0, 240) || null;
  await upsertPushSubscriptionD1(c.env.DB, {
    ...validated.subscription,
    userAgent,
  });
  const subscriptionCount = await countPushSubscriptionsD1(c.env.DB);
  return c.json({ subscribed: true, subscriptionCount });
});

app.post('/api/push/unsubscribe', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.trim() : '';
  if (!endpoint) {
    return c.json({ error: 'Push endpoint is required.' }, 400);
  }
  await deletePushSubscriptionD1(c.env.DB, endpoint);
  const subscriptionCount = await countPushSubscriptionsD1(c.env.DB);
  return c.json({ unsubscribed: true, subscriptionCount });
});

app.post('/api/notifications/test', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const channelRaw = body?.channel;
  const onlyChannel =
    channelRaw === 'email' || channelRaw === 'telegram' || channelRaw === 'push'
      ? channelRaw
      : undefined;

  const settings = await getSettingsD1(c.env.DB);
  const alert = await dispatchEdgeAlert(c.env, settings, {
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

  await insertAlertD1(c.env.DB, alert);
  return c.json({ alert });
});

app.delete('/api/alerts/:id', async (c) => {
  const id = (c.req.param('id') || '').trim();
  if (!id) {
    return c.json({ error: 'Alert ID is required.' }, 400);
  }
  const deleted = await deleteAlertD1(c.env.DB, id);
  if (!deleted) {
    return c.json({ error: 'Alert log not found.' }, 404);
  }
  return c.json({ deleted: true });
});

app.delete('/api/alerts', async (c) => {
  await clearAlertsD1(c.env.DB);
  return c.json({ cleared: true });
});

app.all('*', async (c) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    return c.env.ASSETS.fetch(c.req.raw);
  }

  const reqUrl = new URL(c.req.url);
  if (
    reqUrl.pathname.startsWith('/assets/') ||
    /\.[a-z0-9]{1,8}$/i.test(reqUrl.pathname)
  ) {
    return c.env.ASSETS.fetch(c.req.raw);
  }

  const indexRequest = new Request(new URL('/', reqUrl.origin).toString(), {
    method: 'GET',
    headers: { Accept: 'text/html' },
  });
  const assetResponse = await c.env.ASSETS.fetch(indexRequest);
  const contentType = assetResponse.headers.get('content-type') || '';

  if (!assetResponse.ok || !contentType.toLowerCase().includes('text/html')) {
    return assetResponse;
  }

  const html = await assetResponse.text();
  let injectedHtml = html;

  try {
    await ensureD1Schema(c.env.DB);
    const dbAuth = await getAuthCredentialsD1(c.env.DB);
    const configuredUser = resolveConfiguredUsername(getEdgeEnvAuth(c.env), dbAuth);
    const auth = await authenticateEdgeRequest(
      c.env,
      c.req.header('authorization'),
      c.req.header('cookie')
    );
    const bootstrap = auth ? await buildWorkerBootstrap(c.env) : null;

    injectedHtml = injectInitialStateIntoHtml(html, {
      auth: {
        configured: Boolean(configuredUser),
        authenticated: Boolean(auth),
        username: auth ? auth.claims.sub : null,
      },
      bootstrap,
    });
  } catch {
    // Graceful fallback: serve unmodified HTML so the client can retry
  }

  const headers = new Headers(assetResponse.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  headers.set('Pragma', 'no-cache');
  headers.set('Vary', 'Cookie');
  headers.delete('ETag');
  headers.delete('Last-Modified');
  headers.delete('Content-Length');
  headers.delete('CF-Cache-Status');

  return new Response(c.req.method === 'HEAD' ? null : injectedHtml, {
    status: 200,
    headers,
  });
});

export default {
  fetch: app.fetch,
  async scheduled(
    _event: WorkerScheduledEvent,
    env: WorkerEnv,
    ctx: WorkerExecutionContext
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await ensureD1Schema(env.DB);
        const nowMs = Date.now();
        const products = await getAllProductsD1(env.DB);
        const due = products.filter((p) => Date.parse(p.nextCheckAt) <= nowMs);
        await runEdgeWithConcurrency(due, EDGE_CHECK_CONCURRENCY, (product) =>
          executeProductCheckEdge(env, product)
        );
      })()
    );
  },
};
