import type {
  AlertLogEntry,
  AlertSettings,
  BootstrapResponse,
  CurrencyCode,
  ServerCapabilities,
  TrackedProduct,
  UrlPreviewResult,
} from '../types/tracker';

let inMemoryAuthToken: string | null = null;
let unauthorizedListener: (() => void) | null = null;

export function setAuthToken(token: string | null): void {
  inMemoryAuthToken = token;
}

export function getAuthToken(): string | null {
  return inMemoryAuthToken;
}

export function setUnauthorizedListener(listener: (() => void) | null): void {
  unauthorizedListener = listener;
}

export interface AuthStatusResponse {
  configured: boolean;
  authenticated: boolean;
  username: string | null;
  bootstrap?: BootstrapResponse | null;
}

export interface AuthSessionResponse {
  token: string;
  username: string;
  bootstrap?: BootstrapResponse;
}

async function requestJson<T>(
  url: string,
  init?: RequestInit,
  options: { skipUnauthorizedHook?: boolean } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'PricePulse',
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (inMemoryAuthToken && !headers.Authorization) {
    headers.Authorization = `Bearer ${inMemoryAuthToken}`;
  }

  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !options.skipUnauthorizedHook) {
      inMemoryAuthToken = null;
      unauthorizedListener?.();
    }
    throw new Error(
      typeof data?.error === 'string' ? data.error : `Request failed (${response.status})`
    );
  }
  return data as T;
}

export async function fetchAuthStatus(
  options: { includeBootstrap?: boolean } = {}
): Promise<AuthStatusResponse> {
  const url = options.includeBootstrap
    ? '/api/auth/status?includeBootstrap=1'
    : '/api/auth/status';
  return requestJson<AuthStatusResponse>(url, undefined, {
    skipUnauthorizedHook: true,
  });
}

export async function loginWithCredentials(
  username: string,
  password: string
): Promise<AuthSessionResponse> {
  return requestJson<AuthSessionResponse>(
    '/api/auth/login',
    {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    },
    { skipUnauthorizedHook: true }
  );
}

export async function setupInitialAccount(
  username: string,
  password: string
): Promise<AuthSessionResponse> {
  return requestJson<AuthSessionResponse>(
    '/api/auth/setup',
    {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    },
    { skipUnauthorizedHook: true }
  );
}

export async function logoutSession(): Promise<void> {
  try {
    await requestJson<{ loggedOut: boolean }>(
      '/api/auth/logout',
      { method: 'POST' },
      { skipUnauthorizedHook: true }
    );
  } catch {
    // Always clear local session even if server request fails
  } finally {
    inMemoryAuthToken = null;
  }
}

export async function fetchBootstrap(): Promise<BootstrapResponse> {
  return requestJson<BootstrapResponse>('/api/bootstrap');
}

export async function previewProductLink(url: string): Promise<UrlPreviewResult> {
  return requestJson<UrlPreviewResult>('/api/products/preview', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}

export interface CreateProductInput {
  url: string;
  title: string;
  currentPrice: number;
  targetPrice: number | null;
  checkIntervalHours: number;
  currency: CurrencyCode;
  imageUrl: string | null;
}

export async function createTrackedProduct(
  input: CreateProductInput
): Promise<{ product: TrackedProduct }> {
  return requestJson<{ product: TrackedProduct }>('/api/products', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateTrackedProduct(
  id: string,
  patch: Partial<{ title: string; targetPrice: number | null; checkIntervalHours: number }>
): Promise<{ product: TrackedProduct }> {
  return requestJson<{ product: TrackedProduct }>(`/api/products/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteTrackedProduct(id: string): Promise<{ deleted: boolean }> {
  return requestJson<{ deleted: boolean }>(`/api/products/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function checkProductPriceNow(
  id: string
): Promise<{ product: TrackedProduct; alert: AlertLogEntry | null }> {
  return requestJson<{ product: TrackedProduct; alert: AlertLogEntry | null }>(
    `/api/products/${encodeURIComponent(id)}/check`,
    { method: 'POST' }
  );
}

export async function recordManualProductPrice(
  id: string,
  price: number
): Promise<{ product: TrackedProduct; alert: AlertLogEntry | null }> {
  return requestJson<{ product: TrackedProduct; alert: AlertLogEntry | null }>(
    `/api/products/${encodeURIComponent(id)}/record-price`,
    {
      method: 'POST',
      body: JSON.stringify({ price }),
    }
  );
}

export async function runScheduleCheckNow(): Promise<{
  checkedCount: number;
  products: TrackedProduct[];
  alerts: AlertLogEntry[];
}> {
  return requestJson('/api/schedule/run-now', { method: 'POST' });
}

export async function saveAlertSettings(
  settings: AlertSettings,
  applyIntervalToAll: boolean = false
): Promise<{
  settings: AlertSettings;
  products: TrackedProduct[];
  capabilities: ServerCapabilities;
}> {
  return requestJson('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ ...settings, applyIntervalToAll }),
  });
}

export async function sendTestNotification(
  channel?: 'email' | 'telegram' | 'push'
): Promise<{ alert: AlertLogEntry }> {
  return requestJson<{ alert: AlertLogEntry }>('/api/notifications/test', {
    method: 'POST',
    body: JSON.stringify({ channel }),
  });
}

export async function deleteAlertLog(id: string): Promise<{ deleted: boolean }> {
  return requestJson<{ deleted: boolean }>(`/api/alerts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function clearAllAlertLogs(): Promise<{ cleared: boolean }> {
  return requestJson<{ cleared: boolean }>('/api/alerts', {
    method: 'DELETE',
  });
}

function decodeBase64UrlToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64Url.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(base64 + padding);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export async function savePushSubscriptionToServer(subscription: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}): Promise<{ subscribed: boolean; subscriptionCount: number }> {
  return requestJson<{ subscribed: boolean; subscriptionCount: number }>('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify(subscription),
  });
}

export async function removePushSubscriptionFromServer(
  endpoint: string
): Promise<{ unsubscribed: boolean; subscriptionCount: number }> {
  return requestJson<{ unsubscribed: boolean; subscriptionCount: number }>(
    '/api/push/unsubscribe',
    {
      method: 'POST',
      body: JSON.stringify({ endpoint }),
    }
  );
}

export async function registerPushServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', {
      updateViaCache: 'none',
    });
    registration.update().catch(() => undefined);
    return registration;
  } catch {
    // Ignore registration error in restricted frames
    return null;
  }
}

export interface SyncPushResult {
  subscribed: boolean;
  subscriptionCount?: number;
  error?: string;
}

/**
 * Ensures this browser has an active Web Push subscription matching the server's
 * VAPID public key and registers it in the backend database so background cron
 * price drops deliver real Chrome OS/browser push notifications even when closed.
 */
export async function syncBrowserPushSubscription(
  vapidPublicKey: string | null
): Promise<SyncPushResult> {
  if (
    typeof window === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  ) {
    return { subscribed: false, error: 'This browser does not support Web Push notifications.' };
  }
  if (Notification.permission !== 'granted') {
    return { subscribed: false, error: 'Browser notification permission is not granted.' };
  }
  if (!vapidPublicKey || !vapidPublicKey.trim()) {
    return { subscribed: false, error: 'Server VAPID keys are not configured yet.' };
  }

  try {
    await registerPushServiceWorker();
    const registration = await navigator.serviceWorker.ready;
    if (!registration?.pushManager) {
      return { subscribed: false, error: 'PushManager is unavailable on this service worker.' };
    }

    const expectedKey = decodeBase64UrlToUint8Array(vapidPublicKey);
    let subscription = await registration.pushManager.getSubscription();

    if (subscription) {
      const existingKeyBuf = subscription.options?.applicationServerKey;
      if (existingKeyBuf) {
        const existingKey = new Uint8Array(existingKeyBuf);
        if (!bytesEqual(existingKey, expectedKey)) {
          await subscription.unsubscribe().catch(() => undefined);
          subscription = null;
        }
      }
    }

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: expectedKey,
      });
    }

    const json = subscription.toJSON();
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (!json.endpoint || !p256dh || !auth) {
      return { subscribed: false, error: 'Browser returned an incomplete push subscription.' };
    }

    const saved = await savePushSubscriptionToServer({
      endpoint: json.endpoint,
      keys: { p256dh, auth },
    });
    return { subscribed: saved.subscribed, subscriptionCount: saved.subscriptionCount };
  } catch (err) {
    return {
      subscribed: false,
      error: err instanceof Error ? err.message : 'Failed to subscribe browser for background push.',
    };
  }
}

export async function showBrowserPushNotification(
  title: string,
  body: string,
  url?: string | null,
  tag: string = 'pricepulse-drop-alert'
): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (Notification.permission !== 'granted') return false;
  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration('/sw.js');
      if (registration && typeof registration.showNotification === 'function') {
        await registration.showNotification(title, {
          body,
          icon: '/favicon.svg',
          tag,
          data: { url: url || '/' },
        });
        return true;
      }
    }
    new Notification(title, { body, tag });
    return true;
  } catch {
    return false;
  }
}
