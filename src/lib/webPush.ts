/**
 * Pure Web Crypto implementation of Web Push (RFC 8291 aes128gcm payload
 * encryption + RFC 8188 record framing + RFC 8292 VAPID ES256 JWT auth).
 *
 * Runs identically in Cloudflare Workers and Node.js 20+ with zero native
 * dependencies.
 */

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface StoredPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface WebPushNotificationPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  alertId?: string;
}

export interface WebPushSendResult {
  ok: boolean;
  status: number;
  gone: boolean;
  error?: string;
}

const textEncoder = new TextEncoder();
const RECORD_SIZE = 4096;
const MAX_PLAINTEXT_BYTES = 3800; // Leaves ample headroom inside 4096-byte push limit
const DEFAULT_TTL_SECONDS = 86_400; // 24 hours
const VAPID_EXPIRY_SECONDS = 12 * 60 * 60; // 12 hours (RFC 8292 max is 24h)

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  const cleaned = input.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!cleaned || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    throw new Error('Invalid base64url string.');
  }
  const padLen = (4 - (cleaned.length % 4)) % 4;
  const padded = cleaned + '='.repeat(padLen);
  const binary = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const arr of arrays) total += arr.length;
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
}

async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    'raw',
    toArrayBufferView(keyBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, toArrayBufferView(data));
  return new Uint8Array(sig);
}

/**
 * Generates a fresh P-256 VAPID keypair in standard URL-safe base64 format:
 * - publicKey: 65-byte uncompressed EC point (0x04 || x || y)
 * - privateKey: 32-byte raw EC private scalar (d)
 */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  if (!jwk.x || !jwk.y || !jwk.d) {
    throw new Error('Failed to export P-256 VAPID keypair JWK.');
  }
  const x = base64UrlDecode(jwk.x);
  const y = base64UrlDecode(jwk.y);
  const d = base64UrlDecode(jwk.d);
  if (x.length !== 32 || y.length !== 32 || d.length !== 32) {
    throw new Error('Unexpected P-256 coordinate length.');
  }
  const uncompressedPublic = concatBytes(new Uint8Array([0x04]), x, y);
  return {
    publicKey: base64UrlEncode(uncompressedPublic),
    privateKey: base64UrlEncode(d),
  };
}

export function isValidVapidSubject(subject: string): boolean {
  const trimmed = subject.trim();
  if (trimmed.startsWith('mailto:') && trimmed.includes('@') && trimmed.length >= 10) {
    return true;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isValidVapidConfig(
  config: Partial<VapidConfig> | null | undefined
): config is VapidConfig {
  if (!config || !config.publicKey || !config.privateKey || !config.subject) {
    return false;
  }
  if (!isValidVapidSubject(config.subject)) {
    return false;
  }
  try {
    const pub = base64UrlDecode(config.publicKey);
    const priv = base64UrlDecode(config.privateKey);
    return pub.length === 65 && pub[0] === 0x04 && priv.length === 32;
  } catch {
    return false;
  }
}

export function resolveVapidConfig(env: {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() || '';
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() || '';
  const subject = env.VAPID_SUBJECT?.trim() || 'mailto:alerts@pricepulse.app';
  const candidate = { publicKey, privateKey, subject };
  return isValidVapidConfig(candidate) ? candidate : null;
}

function isDisallowedPushHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split('.').map(Number);
    if (
      parts[0] === 10 ||
      parts[0] === 127 ||
      parts[0] === 0 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168)
    ) {
      return true;
    }
  }
  if (host.includes(':')) {
    return true;
  }
  return false;
}

export function validatePushSubscriptionInput(
  raw: unknown
): { valid: true; subscription: StoredPushSubscription } | { valid: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { valid: false, error: 'Push subscription payload is required.' };
  }
  const obj = raw as Record<string, unknown>;
  const endpointRaw = typeof obj.endpoint === 'string' ? obj.endpoint.trim() : '';
  if (!endpointRaw || endpointRaw.length > 2048) {
    return { valid: false, error: 'A valid push endpoint URL is required.' };
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(endpointRaw);
  } catch {
    return { valid: false, error: 'Push endpoint must be a valid URL.' };
  }
  if (parsedUrl.protocol !== 'https:' || isDisallowedPushHost(parsedUrl.hostname)) {
    return { valid: false, error: 'Push endpoint must use a public HTTPS host.' };
  }

  const keysObj =
    obj.keys && typeof obj.keys === 'object'
      ? (obj.keys as Record<string, unknown>)
      : obj;
  const p256dhRaw = typeof keysObj.p256dh === 'string' ? keysObj.p256dh.trim() : '';
  const authRaw = typeof keysObj.auth === 'string' ? keysObj.auth.trim() : '';

  try {
    const p256dhBytes = base64UrlDecode(p256dhRaw);
    if (p256dhBytes.length !== 65 || p256dhBytes[0] !== 0x04) {
      return { valid: false, error: 'Push subscription p256dh key must be a 65-byte P-256 point.' };
    }
  } catch {
    return { valid: false, error: 'Push subscription p256dh key is malformed.' };
  }

  try {
    const authBytes = base64UrlDecode(authRaw);
    if (authBytes.length !== 16) {
      return { valid: false, error: 'Push subscription auth secret must be 16 bytes.' };
    }
  } catch {
    return { valid: false, error: 'Push subscription auth secret is malformed.' };
  }

  return {
    valid: true,
    subscription: {
      endpoint: parsedUrl.toString(),
      p256dh: base64UrlEncode(base64UrlDecode(p256dhRaw)),
      auth: base64UrlEncode(base64UrlDecode(authRaw)),
    },
  };
}

/**
 * Builds the RFC 8292 VAPID Authorization header:
 * `vapid t=<ES256 JWT>, k=<base64url uncompressed public key>`
 */
export async function buildVapidAuthorizationHeader(
  endpoint: string,
  config: VapidConfig,
  nowSec: number = Math.floor(Date.now() / 1000)
): Promise<string> {
  if (!isValidVapidConfig(config)) {
    throw new Error('Invalid VAPID configuration.');
  }
  const aud = new URL(endpoint).origin;
  const pubBytes = base64UrlDecode(config.publicKey);
  const x = base64UrlEncode(pubBytes.slice(1, 33));
  const y = base64UrlEncode(pubBytes.slice(33, 65));

  const signingKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x,
      y,
      d: config.privateKey,
      ext: false,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const headerB64 = base64UrlEncode(textEncoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payloadB64 = base64UrlEncode(
    textEncoder.encode(
      JSON.stringify({
        aud,
        exp: nowSec + VAPID_EXPIRY_SECONDS,
        sub: config.subject,
      })
    )
  );
  const signingInput = `${headerB64}.${payloadB64}`;
  const sigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingKey,
    textEncoder.encode(signingInput)
  );
  const jwt = `${signingInput}.${base64UrlEncode(new Uint8Array(sigBuf))}`;
  return `vapid t=${jwt}, k=${config.publicKey}`;
}

export interface EncryptWebPushOptions {
  ephemeralKeyPair?: CryptoKeyPair;
  salt?: Uint8Array;
}

/**
 * Encrypts a push message payload according to RFC 8291 (aes128gcm) + RFC 8188.
 */
export async function encryptWebPushPayload(
  plaintext: Uint8Array,
  uaPublicBytes: Uint8Array,
  authSecretBytes: Uint8Array,
  options?: EncryptWebPushOptions
): Promise<Uint8Array<ArrayBuffer>> {
  if (uaPublicBytes.length !== 65 || uaPublicBytes[0] !== 0x04) {
    throw new Error('User agent public key must be an uncompressed 65-byte P-256 point.');
  }
  if (authSecretBytes.length !== 16) {
    throw new Error('User agent auth secret must be 16 bytes.');
  }
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error(`Web Push payload exceeds ${MAX_PLAINTEXT_BYTES} bytes.`);
  }

  const ephemeral =
    options?.ephemeralKeyPair ??
    (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));

  const asPublicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  if (asPublicBytes.length !== 65 || asPublicBytes[0] !== 0x04) {
    throw new Error('Failed to export ephemeral P-256 public key.');
  }

  const uaPublicKey = await crypto.subtle.importKey(
    'raw',
    toArrayBufferView(uaPublicBytes),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaPublicKey },
    ephemeral.privateKey,
    256
  );
  const ecdhSecret = new Uint8Array(sharedBits);

  const salt = options?.salt
    ? toArrayBufferView(options.salt)
    : crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  if (salt.length !== 16) {
    throw new Error('Salt must be 16 bytes.');
  }

  // RFC 8291 Section 3.3: Combine ECDH shared secret with authentication secret
  const prkKey = await hmacSha256(authSecretBytes, ecdhSecret);
  const keyInfo = concatBytes(
    textEncoder.encode('WebPush: info\0'),
    uaPublicBytes,
    asPublicBytes,
    new Uint8Array([0x01])
  );
  const ikm = await hmacSha256(prkKey, keyInfo);

  // RFC 8291 Section 3.4 & RFC 8188: Derive CEK (16B) and NONCE (12B)
  const prk = await hmacSha256(salt, ikm);
  const cekFull = await hmacSha256(
    prk,
    concatBytes(textEncoder.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([0x01]))
  );
  const cek = cekFull.slice(0, 16);

  const nonceFull = await hmacSha256(
    prk,
    concatBytes(textEncoder.encode('Content-Encoding: nonce\0'), new Uint8Array([0x01]))
  );
  const nonce = nonceFull.slice(0, 12);

  // RFC 8188: Single final record delimiter 0x02
  const paddedPlaintext = concatBytes(plaintext, new Uint8Array([0x02]));

  const aesKey = await crypto.subtle.importKey(
    'raw',
    toArrayBufferView(cek),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBufferView(nonce), tagLength: 128 },
    aesKey,
    paddedPlaintext
  );
  const ciphertext = new Uint8Array(ciphertextBuf);

  // RFC 8188 Header: salt (16) || rs (4 BE) || idlen (1) || keyid (65)
  const header = new Uint8Array(new ArrayBuffer(16 + 4 + 1 + asPublicBytes.length));
  header.set(salt, 0);
  const view = new DataView(header.buffer);
  view.setUint32(16, RECORD_SIZE, false);
  header[20] = asPublicBytes.length;
  header.set(asPublicBytes, 21);

  return concatBytes(header, ciphertext);
}

function serializeNotificationPayload(payload: WebPushNotificationPayload): Uint8Array {
  const safe: WebPushNotificationPayload = {
    title: payload.title.slice(0, 140),
    body: payload.body.slice(0, 320),
    url: payload.url || '/',
    tag: payload.tag || 'pricepulse-drop-alert',
    ...(payload.alertId ? { alertId: payload.alertId } : {}),
  };
  return textEncoder.encode(JSON.stringify(safe));
}

export async function sendWebPushMessage(
  subscription: StoredPushSubscription,
  payload: WebPushNotificationPayload,
  vapid: VapidConfig,
  fetchImpl: typeof fetch = fetch
): Promise<WebPushSendResult> {
  const validation = validatePushSubscriptionInput(subscription);
  if (!validation.valid) {
    return { ok: false, status: 0, gone: false, error: validation.error };
  }

  try {
    const uaPublic = base64UrlDecode(validation.subscription.p256dh);
    const authSecret = base64UrlDecode(validation.subscription.auth);
    const plaintext = serializeNotificationPayload(payload);
    const encryptedBody = await encryptWebPushPayload(plaintext, uaPublic, authSecret);
    const authorization = await buildVapidAuthorizationHeader(
      validation.subscription.endpoint,
      vapid
    );

    const res = await fetchImpl(validation.subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(DEFAULT_TTL_SECONDS),
        Urgency: 'high',
      },
      body: encryptedBody,
    });

    if (res.ok) {
      return { ok: true, status: res.status, gone: false };
    }

    const errText = await res.text().catch(() => '');
    const gone = res.status === 404 || res.status === 410;
    return {
      ok: false,
      status: res.status,
      gone,
      error: gone
        ? `Push subscription expired (${res.status}).`
        : `Push service rejected request (${res.status})${errText ? `: ${errText.slice(0, 120)}` : ''}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      gone: false,
      error: err instanceof Error ? `Web Push error: ${err.message}` : 'Web Push delivery failed.',
    };
  }
}
