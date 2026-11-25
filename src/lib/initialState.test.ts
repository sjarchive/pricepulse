import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  INITIAL_STATE_GLOBAL_KEY,
  consumeInitialAppState,
  injectInitialStateIntoHtml,
  sanitizeInitialAppState,
  serializeInitialAppState,
  type InitialAppState,
} from './initialState';
import type { BootstrapResponse } from '../types/tracker';

const sampleBootstrap: BootstrapResponse = {
  products: [
    {
      id: 'prod-1',
      url: 'https://example.com/item?a=1&b=2',
      title: 'USB-C Hub </script><script>alert(1)</script> $& $$ $1',
      platform: 'amazon',
      platformLabel: 'Amazon',
      currency: 'USD',
      imageUrl: null,
      currentPrice: 49.99,
      initialPrice: 59.99,
      lowestPrice: 49.99,
      highestPrice: 59.99,
      targetPrice: 45,
      checkIntervalHours: 2,
      lastCheckedAt: '2026-01-01T00:00:00.000Z',
      nextCheckAt: '2026-01-01T02:00:00.000Z',
      lastCheckStatus: 'ok',
      lastCheckNote: 'Line\u2028Break\u2029Test',
      inStock: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      history: [{ timestamp: '2026-01-01T00:00:00.000Z', price: 49.99, source: 'live' }],
    },
  ],
  settings: {
    defaultCheckIntervalHours: 1,
    triggerMode: 'any_drop',
    minDropPercent: 5,
    email: { enabled: false, address: '' },
    telegram: { enabled: false, chatId: '' },
    push: { enabled: true },
  },
  alerts: [],
  capabilities: {
    emailConfigured: false,
    telegramBotConfigured: false,
  },
};

test('sanitizeInitialAppState strips bootstrap and username when unauthenticated', () => {
  const dirty: InitialAppState = {
    auth: { configured: true, authenticated: false, username: 'admin' },
    bootstrap: sampleBootstrap,
  };

  const clean = sanitizeInitialAppState(dirty);
  assert.deepEqual(clean, {
    auth: { configured: true, authenticated: false, username: null },
    bootstrap: null,
  });
});

test('serializeInitialAppState escapes HTML breakout chars and JS line separators', () => {
  const serialized = serializeInitialAppState({
    auth: { configured: true, authenticated: true, username: 'admin' },
    bootstrap: sampleBootstrap,
  });

  assert.equal(serialized.includes('</script>'), false);
  assert.equal(serialized.includes('<'), false);
  assert.equal(serialized.includes('>'), false);
  assert.equal(serialized.includes('&'), false);
  assert.equal(serialized.includes('\u2028'), false);
  assert.equal(serialized.includes('\u2029'), false);
});

test('injectInitialStateIntoHtml preserves special $ sequences and executes cleanly', () => {
  const html = '<!doctype html><html><head><title>PricePulse</title></head><body><div id="root"></div></body></html>';
  const injected = injectInitialStateIntoHtml(html, {
    auth: { configured: true, authenticated: true, username: 'admin' },
    bootstrap: sampleBootstrap,
  });

  assert.equal(injected.includes('</head>'), true);
  assert.equal(injected.indexOf('__pricepulse_initial_state__') < injected.indexOf('</head>'), true);

  const match = injected.match(/<script id="__pricepulse_initial_state__">([\s\S]*?)<\/script>/);
  assert.ok(match, 'expected injected script tag');

  const sandbox: { window: Record<string, unknown> } = { window: {} };
  vm.runInNewContext(match[1], sandbox);

  const consumed = consumeInitialAppState(sandbox.window);
  assert.ok(consumed);
  assert.equal(consumed.auth.authenticated, true);
  assert.equal(consumed.auth.username, 'admin');
  assert.equal(
    consumed.bootstrap?.products[0]?.title,
    'USB-C Hub </script><script>alert(1)</script> $& $$ $1'
  );
  assert.equal(consumed.bootstrap?.products[0]?.lastCheckNote, 'Line\u2028Break\u2029Test');
  assert.equal(sandbox.window[INITIAL_STATE_GLOBAL_KEY], undefined);
  assert.equal(consumeInitialAppState(sandbox.window), null);
});

test('consumeInitialAppState rejects malformed payloads safely', () => {
  const target: Record<string, unknown> = {
    [INITIAL_STATE_GLOBAL_KEY]: { auth: { configured: 'yes' }, bootstrap: null },
  };
  assert.equal(consumeInitialAppState(target), null);
  assert.equal(target[INITIAL_STATE_GLOBAL_KEY], undefined);
});
