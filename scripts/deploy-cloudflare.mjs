import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const WRANGLER_CONFIG = path.join(ROOT, 'wrangler.jsonc');
const DB_NAME = 'pricepulse-db';

function runWrangler(args, opts = {}) {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: process.env,
  });
}

function ensureToken() {
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_API_TOKEN.trim()) {
    console.error(
      'Missing CLOUDFLARE_API_TOKEN environment variable. Add CLOUDFLARE_API_TOKEN in Secrets (or export it in your shell) and re-run.'
    );
    process.exit(1);
  }
}

function resolveOrCreateD1Database() {
  console.log('Checking Cloudflare D1 databases...');
  const listRaw = runWrangler(['d1', 'list', '--json'], { capture: true });
  const list = JSON.parse(listRaw);
  const existing = Array.isArray(list) ? list.find((d) => d.name === DB_NAME) : null;

  if (existing && existing.uuid) {
    console.log(`Found existing D1 database "${DB_NAME}" (${existing.uuid}).`);
    return existing.uuid;
  }

  console.log(`Creating D1 database "${DB_NAME}"...`);
  const createOut = runWrangler(['d1', 'create', DB_NAME], { capture: true });
  const uuidMatch = createOut.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  );
  if (!uuidMatch) {
    throw new Error('Created D1 database, but could not parse database UUID from Wrangler output.');
  }
  console.log(`Created D1 database "${DB_NAME}" (${uuidMatch[0]}).`);
  return uuidMatch[0];
}

function updateWranglerDatabaseId(databaseId) {
  const raw = fs.readFileSync(WRANGLER_CONFIG, 'utf8');
  const updated = raw.replace(
    /"database_id"\s*:\s*"[^"]*"/,
    `"database_id": "${databaseId}"`
  );
  fs.writeFileSync(WRANGLER_CONFIG, updated, 'utf8');
}

function syncOptionalWorkerSecrets() {
  const secretKeys = [
    'RESEND_API_KEY',
    'RESEND_FROM',
    'TELEGRAM_BOT_TOKEN',
    'VAPID_PUBLIC_KEY',
    'VAPID_PRIVATE_KEY',
    'VAPID_SUBJECT',
    'AUTH_USERNAME',
    'AUTH_PASSWORD_HASH',
    'AUTH_SESSION_SECRET',
  ];
  for (const key of secretKeys) {
    const val = process.env[key]?.trim();
    if (!val) continue;
    console.log(`Syncing secret ${key} to Cloudflare Worker...`);
    execFileSync('npx', ['wrangler', 'secret', 'put', key], {
      cwd: ROOT,
      input: val,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: process.env,
    });
  }
}

async function main() {
  ensureToken();

  console.log('Building frontend assets...');
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', env: process.env });

  const databaseId = resolveOrCreateD1Database();
  updateWranglerDatabaseId(databaseId);

  console.log('Applying D1 database migrations...');
  runWrangler(['d1', 'migrations', 'apply', DB_NAME, '--remote']);

  console.log('Deploying PricePulse to Cloudflare Workers...');
  runWrangler(['deploy']);

  syncOptionalWorkerSecrets();
  console.log('Cloudflare Workers deployment completed!');
}

main().catch((err) => {
  console.error('Deployment failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
