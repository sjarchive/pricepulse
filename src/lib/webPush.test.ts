import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  base64UrlDecode,
  base64UrlEncode,
  buildVapidAuthorizationHeader,
  encryptWebPushPayload,
  generateVapidKeys,
  isValidVapidConfig,
  sendWebPushMessage,
  validatePushSubscriptionInput,
} from './webPush';

/**
 * Independent RFC 8291 + RFC 8188 decryptor using Node's native node:crypto
 * primitives (createECDH, hkdfSync, createDecipheriv) to verify our Web Crypto
 * encryptor produces wire-compatible aes128gcm payloads.
 */
function decryptAes128GcmNode(
  encrypted: Uint8Array,
  uaPrivateKey: Buffer,
  uaPublicKey: Buffer,
  authSecret: Buffer
): string {
  const buf = Buffer.from(encrypted);
  const salt = buf.subarray(0, 16);
  const rs = buf.readUInt32BE(16);
  assert.equal(rs, 4096);
  const idlen = buf[20];
  assert.equal(idlen, 65);
  const asPublicKey = buf.subarray(21, 21 + idlen);
  assert.equal(asPublicKey[0], 0x04);
  const ciphertextWithTag = buf.subarray(21 + idlen);

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivateKey);
  const ecdhSecret = ecdh.computeSecret(asPublicKey);

  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    uaPublicKey,
    asPublicKey,
  ]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16)
  );
  const nonce = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12)
  );

  const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  // Strip trailing 0x00 padding (if any) and verify RFC 8188 final-record delimiter 0x02
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0x00) end -= 1;
  assert.equal(padded[end], 0x02, 'expected RFC 8188 final record delimiter 0x02');
  return padded.subarray(0, end).toString('utf8');
}

test('generateVapidKeys creates a valid P-256 VAPID keypair and verifies ES256 JWT', async () => {
  const keys = await generateVapidKeys();
  const config = {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subject: 'mailto:alerts@pricepulse.app',
  };
  assert.equal(isValidVapidConfig(config), true);
  assert.equal(base64UrlDecode(keys.publicKey).length, 65);
  assert.equal(base64UrlDecode(keys.publicKey)[0], 0x04);
  assert.equal(base64UrlDecode(keys.privateKey).length, 32);

  const endpoint = 'https://fcm.googleapis.com/fcm/send/sample-token-123';
  const nowSec = 1_750_000_000;
  const authHeader = await buildVapidAuthorizationHeader(endpoint, config, nowSec);
  assert.ok(authHeader.startsWith('vapid t='));
  assert.ok(authHeader.endsWith(`, k=${keys.publicKey}`));

  const token = authHeader.slice('vapid t='.length, authHeader.indexOf(', k='));
  const [headerB64, payloadB64, sigB64] = token.split('.');
  const header = JSON.parse(Buffer.from(base64UrlDecode(headerB64)).toString('utf8'));
  const payload = JSON.parse(Buffer.from(base64UrlDecode(payloadB64)).toString('utf8'));
  assert.deepEqual(header, { typ: 'JWT', alg: 'ES256' });
  assert.equal(payload.aud, 'https://fcm.googleapis.com');
  assert.equal(payload.sub, 'mailto:alerts@pricepulse.app');
  assert.equal(payload.exp, nowSec + 12 * 3600);

  const sigBytes = base64UrlDecode(sigB64);
  assert.equal(sigBytes.length, 64, 'ES256 JWT signature must be 64-byte IEEE P1363 format');

  const pubKey = await globalThis.crypto.subtle.importKey(
    'raw',
    base64UrlDecode(keys.publicKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  const valid = await globalThis.crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    pubKey,
    sigBytes,
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  assert.equal(valid, true);
});

test('encryptWebPushPayload round-trips cleanly with independent RFC 8291 Node decryptor', async () => {
  const uaEcdh = crypto.createECDH('prime256v1');
  uaEcdh.generateKeys();
  const uaPublic = uaEcdh.getPublicKey();
  const uaPrivate = uaEcdh.getPrivateKey();
  const authSecret = crypto.randomBytes(16);

  const original = JSON.stringify({
    title: 'Price Drop (18%): Skechers Women Ultra Flex',
    body: 'Price dropped by 18% (₹4,499 → ₹3,689) on Myntra.',
    url: 'https://www.myntra.com/example',
    tag: 'pricepulse-alert-1234',
  });

  const encrypted = await encryptWebPushPayload(
    new TextEncoder().encode(original),
    new Uint8Array(uaPublic),
    new Uint8Array(authSecret)
  );

  const decrypted = decryptAes128GcmNode(encrypted, uaPrivate, uaPublic, authSecret);
  assert.equal(decrypted, original);
});

test('validatePushSubscriptionInput enforces HTTPS public endpoints and key lengths', () => {
  const uaEcdh = crypto.createECDH('prime256v1');
  uaEcdh.generateKeys();
  const p256dh = base64UrlEncode(new Uint8Array(uaEcdh.getPublicKey()));
  const auth = base64UrlEncode(new Uint8Array(crypto.randomBytes(16)));

  const ok = validatePushSubscriptionInput({
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys: { p256dh, auth },
  });
  assert.equal(ok.valid, true);

  assert.equal(
    validatePushSubscriptionInput({
      endpoint: 'http://fcm.googleapis.com/fcm/send/abc123',
      keys: { p256dh, auth },
    }).valid,
    false
  );

  assert.equal(
    validatePushSubscriptionInput({
      endpoint: 'https://127.0.0.1/push',
      keys: { p256dh, auth },
    }).valid,
    false
  );

  assert.equal(
    validatePushSubscriptionInput({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      keys: { p256dh: 'short', auth },
    }).valid,
    false
  );
});

test('sendWebPushMessage handles 201 success and marks 410/404 subscriptions as gone', async () => {
  const vapidKeys = await generateVapidKeys();
  const vapid = {
    publicKey: vapidKeys.publicKey,
    privateKey: vapidKeys.privateKey,
    subject: 'mailto:alerts@pricepulse.app',
  };

  const uaEcdh = crypto.createECDH('prime256v1');
  uaEcdh.generateKeys();
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint',
    p256dh: base64UrlEncode(new Uint8Array(uaEcdh.getPublicKey())),
    auth: base64UrlEncode(new Uint8Array(crypto.randomBytes(16))),
  };

  let capturedHeaders: Record<string, string> = {};
  const capturedBodies: Uint8Array[] = [];

  const okResult = await sendWebPushMessage(
    subscription,
    {
      title: 'Price Drop',
      body: 'Dropped to ₹1,999',
      url: 'https://example.com/item',
      tag: 'pricepulse-test',
    },
    vapid,
    async (_url, init) => {
      capturedHeaders = (init?.headers || {}) as Record<string, string>;
      if (init?.body instanceof Uint8Array) capturedBodies.push(init.body);
      return new Response(null, { status: 201 });
    }
  );

  assert.equal(okResult.ok, true);
  assert.equal(okResult.status, 201);
  assert.equal(okResult.gone, false);
  assert.equal(capturedHeaders['Content-Encoding'], 'aes128gcm');
  assert.equal(capturedHeaders['TTL'], '86400');
  assert.ok(capturedHeaders['Authorization']?.startsWith('vapid t='));
  assert.ok(capturedBodies.length === 1 && capturedBodies[0].length > 86);

  const goneResult = await sendWebPushMessage(
    subscription,
    { title: 'Drop', body: 'Test', url: '/', tag: 't' },
    vapid,
    async () => new Response('Gone', { status: 410 })
  );
  assert.equal(goneResult.ok, false);
  assert.equal(goneResult.gone, true);
  assert.equal(goneResult.status, 410);
});
