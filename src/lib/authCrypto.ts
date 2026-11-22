const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const DERIVED_KEY_BITS = 256;
export const SESSION_COOKIE_NAME = 'pp_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const DEFAULT_SESSION_TTL_SECONDS = SESSION_TTL_SECONDS;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(input: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export function generateRandomHex(byteLength: number = 32): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', textEncoder.encode(value));
  return new Uint8Array(digest);
}

export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  return timingSafeEqualBytes(hashA, hashB);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  globalThis.crypto.getRandomValues(salt);

  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    textEncoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    DERIVED_KEY_BITS
  );

  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${bytesToHex(salt)}$${bytesToHex(new Uint8Array(derivedBits))}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;

  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 500_000) {
    return false;
  }

  const salt = hexToBytes(parts[2]);
  const expectedKey = hexToBytes(parts[3]);
  if (!salt || !expectedKey || salt.length < 8 || expectedKey.length !== 32) {
    return false;
  }

  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    textEncoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    expectedKey.length * 8
  );

  return timingSafeEqualBytes(new Uint8Array(derivedBits), expectedKey);
}

export interface SessionClaims {
  sub: string;
  iat: number;
  exp: number;
  jti: string;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signSessionToken(
  username: string,
  secret: string,
  ttlSeconds: number = DEFAULT_SESSION_TTL_SECONDS
): Promise<{ token: string; claims: SessionClaims }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const claims: SessionClaims = {
    sub: username,
    iat: nowSec,
    exp: nowSec + ttlSeconds,
    jti: generateRandomHex(16),
  };

  const payloadB64 = bytesToBase64Url(textEncoder.encode(JSON.stringify(claims)));
  const key = await importHmacKey(secret);
  const sigBuf = await globalThis.crypto.subtle.sign('HMAC', key, textEncoder.encode(payloadB64));
  const sigB64 = bytesToBase64Url(new Uint8Array(sigBuf));

  return { token: `${payloadB64}.${sigB64}`, claims };
}

export async function verifySessionToken(
  token: string,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000)
): Promise<SessionClaims | null> {
  if (!token || typeof token !== 'string') return null;
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0 || dotIdx !== token.lastIndexOf('.')) return null;

  const payloadB64 = token.slice(0, dotIdx);
  const sigB64 = token.slice(dotIdx + 1);
  const providedSig = base64UrlToBytes(sigB64);
  if (!providedSig || providedSig.length !== 32) return null;

  const key = await importHmacKey(secret);
  const expectedSigBuf = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    textEncoder.encode(payloadB64)
  );
  if (!timingSafeEqualBytes(providedSig, new Uint8Array(expectedSigBuf))) {
    return null;
  }

  const payloadBytes = base64UrlToBytes(payloadB64);
  if (!payloadBytes) return null;

  try {
    const parsed = JSON.parse(textDecoder.decode(payloadBytes)) as Partial<SessionClaims>;
    if (
      typeof parsed.sub !== 'string' ||
      !parsed.sub ||
      typeof parsed.iat !== 'number' ||
      typeof parsed.exp !== 'number' ||
      typeof parsed.jti !== 'string' ||
      !parsed.jti
    ) {
      return null;
    }
    if (parsed.exp <= nowSec) return null;
    return {
      sub: parsed.sub,
      iat: parsed.iat,
      exp: parsed.exp,
      jti: parsed.jti,
    };
  } catch {
    return null;
  }
}

export function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const trimmed = authHeader.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) return null;
  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

export function extractCookieValue(
  cookieHeader: string | null | undefined,
  cookieName: string = SESSION_COOKIE_NAME
): string | null {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  const prefix = `${cookieName}=`;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length).trim();
      if (value.length > 0) {
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      }
    }
  }
  return null;
}

export function buildSessionCookieHeader(
  token: string,
  options: { isHttps: boolean; maxAgeSeconds?: number }
): string {
  const maxAge = Math.max(0, Math.floor(options.maxAgeSeconds ?? SESSION_TTL_SECONDS));
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${maxAge}`,
  ];
  if (options.isHttps) {
    attrs.push('Secure', 'SameSite=None', 'Partitioned');
  } else {
    attrs.push('SameSite=Lax');
  }
  return attrs.join('; ');
}

export function buildClearSessionCookieHeader(options: { isHttps: boolean }): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (options.isHttps) {
    attrs.push('Secure', 'SameSite=None', 'Partitioned');
  } else {
    attrs.push('SameSite=Lax');
  }
  return attrs.join('; ');
}

export function isCsrfSafeRequest(params: {
  method: string;
  hasBearerAuth: boolean;
  origin?: string | null;
  host?: string | null;
  forwardedHost?: string | null;
  requestedWith?: string | null;
}): boolean {
  const method = params.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return true;
  }
  // Explicit Authorization: Bearer tokens are never auto-sent by browsers on cross-site requests
  if (params.hasBearerAuth) {
    return true;
  }

  const expectedHost = (params.forwardedHost || params.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase();

  if (params.origin) {
    try {
      const originHost = new URL(params.origin).host.toLowerCase();
      if (!expectedHost || originHost !== expectedHost) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  return params.requestedWith?.trim() === 'PricePulse';
}

export interface StoredAuthRecord {
  username: string;
  passwordHash: string;
  updatedAt: string;
}

export interface EnvAuthConfig {
  username?: string;
  password?: string;
  passwordHash?: string;
}

export function resolveConfiguredUsername(
  envAuth: EnvAuthConfig,
  dbAuth: StoredAuthRecord | null
): string | null {
  const envUser = envAuth.username?.trim();
  const hasEnvPass = Boolean(envAuth.passwordHash?.trim() || envAuth.password);
  if (envUser && hasEnvPass) return envUser;
  if (dbAuth?.username && dbAuth?.passwordHash) return dbAuth.username;
  return null;
}

export async function verifyLoginCredentials(
  inputUsername: string,
  inputPassword: string,
  envAuth: EnvAuthConfig,
  dbAuth: StoredAuthRecord | null
): Promise<{ valid: boolean; username: string | null }> {
  const cleanUser = inputUsername.trim();
  if (!cleanUser || !inputPassword) {
    return { valid: false, username: null };
  }

  const envUser = envAuth.username?.trim();
  const envHash = envAuth.passwordHash?.trim();
  const envPass = envAuth.password;

  if (envUser && (envHash || envPass)) {
    const userOk = await timingSafeEqualStrings(cleanUser, envUser);
    const passOk = envHash
      ? await verifyPassword(inputPassword, envHash)
      : await timingSafeEqualStrings(inputPassword, envPass || '');
    return { valid: userOk && passOk, username: userOk && passOk ? envUser : null };
  }

  if (dbAuth?.username && dbAuth?.passwordHash) {
    const userOk = await timingSafeEqualStrings(cleanUser, dbAuth.username);
    const passOk = await verifyPassword(inputPassword, dbAuth.passwordHash);
    return { valid: userOk && passOk, username: userOk && passOk ? dbAuth.username : null };
  }

  return { valid: false, username: null };
}
