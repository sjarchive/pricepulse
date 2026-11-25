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

export async function registerPushServiceWorker(): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch {
    // Ignore registration error in restricted frames
  }
}

export async function showBrowserPushNotification(title: string, body: string, url?: string | null): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (Notification.permission !== 'granted') return false;

  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration('/sw.js');
      if (registration && typeof registration.showNotification === 'function') {
        await registration.showNotification(title, {
          body,
          tag: 'pricepulse-drop-alert',
          data: { url: url || '/' },
        });
        return true;
      }
    }
    new Notification(title, { body });
    return true;
  } catch {
    return false;
  }
}
