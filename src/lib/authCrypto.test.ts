import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClearSessionCookieHeader,
  buildSessionCookieHeader,
  extractBearerToken,
  extractCookieValue,
  hashPassword,
  isCsrfSafeRequest,
  resolveConfiguredUsername,
  SESSION_COOKIE_NAME,
  signSessionToken,
  timingSafeEqualStrings,
  verifyLoginCredentials,
  verifyPassword,
  verifySessionToken,
} from './authCrypto';

test('hashPassword and verifyPassword use unique salts and validate correctly', async () => {
  const hash1 = await hashPassword('CorrectHorseBattery99!');
  const hash2 = await hashPassword('CorrectHorseBattery99!');

  assert.notEqual(hash1, hash2);
  assert.ok(hash1.startsWith('pbkdf2_sha256$100000$'));
  assert.equal(await verifyPassword('CorrectHorseBattery99!', hash1), true);
  assert.equal(await verifyPassword('WrongPassword', hash1), false);
  assert.equal(await verifyPassword('CorrectHorseBattery99!', 'malformed-hash'), false);
});

test('signSessionToken and verifySessionToken enforce signature integrity and expiry', async () => {
  const secret = 'test-signing-secret-with-high-entropy-0123456789';
  const { token, claims } = await signSessionToken('alice', secret, 300);

  const verified = await verifySessionToken(token, secret, claims.iat + 10);
  assert.ok(verified);
  assert.equal(verified?.sub, 'alice');
  assert.equal(verified?.jti, claims.jti);

  // Reject wrong secret
  assert.equal(await verifySessionToken(token, 'wrong-secret', claims.iat + 10), null);

  // Reject tampered payload
  const [payload, sig] = token.split('.');
  const tampered = `${payload.slice(0, -2)}AA.${sig}`;
  assert.equal(await verifySessionToken(tampered, secret, claims.iat + 10), null);

  // Reject expired token
  assert.equal(await verifySessionToken(token, secret, claims.exp + 1), null);
});

test('verifyLoginCredentials checks env credentials first and falls back to DB hash', async () => {
  const dbHash = await hashPassword('DbSecret#1');
  const dbRecord = {
    username: 'dbuser',
    passwordHash: dbHash,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  assert.equal(resolveConfiguredUsername({}, null), null);
  assert.equal(resolveConfiguredUsername({}, dbRecord), 'dbuser');

  const dbOk = await verifyLoginCredentials('dbuser', 'DbSecret#1', {}, dbRecord);
  assert.equal(dbOk.valid, true);
  assert.equal(dbOk.username, 'dbuser');

  const dbWrong = await verifyLoginCredentials('dbuser', 'WrongPass', {}, dbRecord);
  assert.equal(dbWrong.valid, false);

  const envHash = await hashPassword('EnvOverride#2');
  const envOverrideFail = await verifyLoginCredentials(
    'dbuser',
    'DbSecret#1',
    { username: 'envadmin', passwordHash: envHash },
    dbRecord
  );
  assert.equal(envOverrideFail.valid, false);

  const envOverridePass = await verifyLoginCredentials(
    'envadmin',
    'EnvOverride#2',
    { username: 'envadmin', passwordHash: envHash },
    dbRecord
  );
  assert.equal(envOverridePass.valid, true);
  assert.equal(envOverridePass.username, 'envadmin');
});

test('extractBearerToken and timingSafeEqualStrings handle edge cases', async () => {
  assert.equal(extractBearerToken('Bearer abc.def'), 'abc.def');
  assert.equal(extractBearerToken('bearer   xyz.123  '), 'xyz.123');
  assert.equal(extractBearerToken('Basic dXNlcjpwYXNz'), null);
  assert.equal(extractBearerToken(undefined), null);

  assert.equal(await timingSafeEqualStrings('demo_user', 'demo_user'), true);
  assert.equal(await timingSafeEqualStrings('demo_user', 'DEMO_USER'), false);
});

test('session cookie helpers extract, build, and clear HttpOnly cookies safely', () => {
  assert.equal(
    extractCookieValue(`theme=light; ${SESSION_COOKIE_NAME}=tok.sig123; other=1`),
    'tok.sig123'
  );
  assert.equal(extractCookieValue('other=1'), null);
  assert.equal(extractCookieValue(undefined), null);

  const httpsCookie = buildSessionCookieHeader('tok.sig', { isHttps: true, maxAgeSeconds: 3600 });
  assert.ok(httpsCookie.includes(`${SESSION_COOKIE_NAME}=tok.sig`));
  assert.ok(httpsCookie.includes('HttpOnly'));
  assert.ok(httpsCookie.includes('Secure'));
  assert.ok(httpsCookie.includes('SameSite=None'));
  assert.ok(httpsCookie.includes('Partitioned'));
  assert.ok(httpsCookie.includes('Max-Age=3600'));

  const httpCookie = buildSessionCookieHeader('tok.sig', { isHttps: false, maxAgeSeconds: 3600 });
  assert.ok(httpCookie.includes('HttpOnly'));
  assert.ok(httpCookie.includes('SameSite=Lax'));
  assert.ok(!httpCookie.includes('Secure'));

  const clearHttps = buildClearSessionCookieHeader({ isHttps: true });
  assert.ok(clearHttps.includes(`${SESSION_COOKIE_NAME}=;`));
  assert.ok(clearHttps.includes('Max-Age=0'));
  assert.ok(clearHttps.includes('Secure'));
  assert.ok(clearHttps.includes('Partitioned'));
});

test('isCsrfSafeRequest validates same-origin and custom header on cookie mutations', () => {
  assert.equal(isCsrfSafeRequest({ method: 'GET', hasBearerAuth: false }), true);
  assert.equal(
    isCsrfSafeRequest({ method: 'POST', hasBearerAuth: true, origin: 'https://evil.example' }),
    true
  );
  assert.equal(
    isCsrfSafeRequest({
      method: 'POST',
      hasBearerAuth: false,
      origin: 'https://pricepulse.nvy.workers.dev',
      host: 'pricepulse.nvy.workers.dev',
    }),
    true
  );
  assert.equal(
    isCsrfSafeRequest({
      method: 'POST',
      hasBearerAuth: false,
      origin: 'https://evil.example',
      host: 'pricepulse.nvy.workers.dev',
      requestedWith: 'PricePulse',
    }),
    false
  );
  assert.equal(
    isCsrfSafeRequest({
      method: 'DELETE',
      hasBearerAuth: false,
      host: 'localhost:3000',
      requestedWith: 'PricePulse',
    }),
    true
  );
  assert.equal(
    isCsrfSafeRequest({
      method: 'DELETE',
      hasBearerAuth: false,
      host: 'localhost:3000',
    }),
    false
  );
});
