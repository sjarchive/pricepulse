import { useCallback, useEffect, useRef, useState } from 'react';
import { Menu } from 'lucide-react';
import {
  checkProductPriceNow,
  clearAllAlertLogs,
  deleteAlertLog,
  deleteTrackedProduct,
  fetchAuthStatus,
  fetchBootstrap,
  getAuthToken,
  logoutSession,
  recordManualProductPrice,
  registerPushServiceWorker,
  runScheduleCheckNow,
  saveAlertSettings,
  sendTestNotification,
  setAuthToken,
  setUnauthorizedListener,
  showBrowserPushNotification,
  updateTrackedProduct,
} from './api/client';
import { AlertSetupView } from './components/AlertSetupView';
import { AlertsHistoryView } from './components/AlertsHistoryView';
import { LoginWall } from './components/LoginWall';
import { ProductDetailPanel } from './components/ProductDetailPanel';
import { PushToastBanner } from './components/PushToastBanner';
import { ScheduleView } from './components/ScheduleView';
import { Sidebar, type NavSection } from './components/Sidebar';
import { TrackProductBar } from './components/TrackProductBar';
import { WatchlistView } from './components/WatchlistView';
import type {
  AlertLogEntry,
  AlertSettings,
  ServerCapabilities,
  SseAlertEvent,
  TrackedProduct,
} from './types/tracker';

const SECTION_TITLES: Record<NavSection, string> = {
  watchlist: 'Watchlist',
  alerts: 'Drop Alerts',
  setup: 'Alert Setup',
  schedule: 'Check Schedule',
};

const DEFAULT_SETTINGS: AlertSettings = {
  defaultCheckIntervalHours: 1,
  triggerMode: 'any_drop',
  minDropPercent: 5,
  email: { enabled: false, address: '' },
  telegram: { enabled: false, chatId: '' },
  push: { enabled: true },
};

export default function App() {
  const [authChecking, setAuthChecking] = useState(true);
  const [authConfigured, setAuthConfigured] = useState(true);
  const [authUsername, setAuthUsername] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  const [activeSection, setActiveSection] = useState<NavSection>('watchlist');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [products, setProducts] = useState<TrackedProduct[]>([]);
  const [settings, setSettings] = useState<AlertSettings>(DEFAULT_SETTINGS);
  const [alerts, setAlerts] = useState<AlertLogEntry[]>([]);
  const [capabilities, setCapabilities] = useState<ServerCapabilities>({
    emailConfigured: false,
    telegramBotConfigured: false,
  });

  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [runningCycle, setRunningCycle] = useState(false);
  const [liveToastAlert, setLiveToastAlert] = useState<AlertLogEntry | null>(null);

  const trackInputRef = useRef<HTMLInputElement | null>(null);

  const clearProtectedState = useCallback(() => {
    setAuthUsername(null);
    setProducts([]);
    setAlerts([]);
    setSettings(DEFAULT_SETTINGS);
    setSelectedProductId(null);
    setLiveToastAlert(null);
    setLoadError(null);
    setActiveSection('watchlist');
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchBootstrap();
      setProducts(data.products);
      setSettings(data.settings);
      setAlerts(data.alerts);
      setCapabilities(data.capabilities);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Unable to load watchlist data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedListener(() => {
      setAuthNotice('Your session expired. Please sign in again.');
      clearProtectedState();
    });
    return () => setUnauthorizedListener(null);
  }, [clearProtectedState]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const status = await fetchAuthStatus();
        if (!active) return;
        setAuthConfigured(status.configured);
        if (status.authenticated && status.username) {
          setAuthUsername(status.username);
        }
      } catch {
        if (active) setAuthConfigured(true);
      } finally {
        if (active) setAuthChecking(false);
      }
    })();
    registerPushServiceWorker();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (authUsername) {
      loadData();
    }
  }, [authUsername, loadData]);

  // Authenticated real-time SSE alert stream (Node) with polling fallback (Cloudflare Workers)
  useEffect(() => {
    if (!authUsername) return;
    const token = getAuthToken();

    const controller = new AbortController();
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const seenIds = new Set<string>();

    const startPollingFallback = () => {
      if (pollTimer) return;
      pollTimer = setInterval(async () => {
        try {
          const fresh = await fetchBootstrap();
          setProducts(fresh.products);
          setAlerts((prev) => {
            const existing = new Set([...prev.map((a) => a.id), ...seenIds]);
            const newest = fresh.alerts.find((a) => !existing.has(a.id));
            if (newest) {
              seenIds.add(newest.id);
              setLiveToastAlert(newest);
              showBrowserPushNotification(newest.productTitle, newest.message, newest.productUrl);
            }
            return fresh.alerts;
          });
        } catch {
          // Ignore transient poll errors
        }
      }, 60_000);
    };

    (async () => {
      try {
        const headers: Record<string, string> = {};
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }
        const res = await fetch('/api/events', {
          credentials: 'same-origin',
          headers,
          signal: controller.signal,
        });
        if (res.status === 204 || !res.ok || !res.body) {
          startPollingFallback();
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() || '';
          for (const frame of frames) {
            const line = frame
              .split('\n')
              .find((l) => l.startsWith('data:'));
            if (!line) continue;
            try {
              const payload = JSON.parse(line.slice(5).trim()) as SseAlertEvent;
              if (payload?.type === 'alert' && payload.alert) {
                seenIds.add(payload.alert.id);
                setAlerts((prev) =>
                  prev.some((a) => a.id === payload.alert.id) ? prev : [payload.alert, ...prev]
                );
                setLiveToastAlert(payload.alert);
                showBrowserPushNotification(
                  payload.alert.productTitle,
                  payload.alert.message,
                  payload.alert.productUrl
                );
              }
            } catch {
              // Ignore malformed keepalive frames
            }
          }
        }
        if (!controller.signal.aborted) {
          startPollingFallback();
        }
      } catch {
        if (!controller.signal.aborted) {
          startPollingFallback();
        }
      }
    })();

    return () => {
      controller.abort();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [authUsername]);

  function handleAuthenticated(token: string, username: string) {
    setAuthToken(token);
    setAuthConfigured(true);
    setAuthNotice(null);
    setAuthUsername(username);
  }

  async function handleSignOut() {
    await logoutSession();
    setAuthNotice(null);
    clearProtectedState();
  }

  function focusTrackProductBar() {
    setActiveSection('watchlist');
    requestAnimationFrame(() => {
      trackInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      trackInputRef.current?.focus();
    });
  }

  function handleProductAdded(product: TrackedProduct) {
    setProducts((prev) => [product, ...prev]);
    setSelectedProductId(product.id);
  }

  async function handleCheckNow(product: TrackedProduct) {
    setCheckingId(product.id);
    try {
      const { product: updated, alert } = await checkProductPriceNow(product.id);
      setProducts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      if (alert) {
        setAlerts((prev) => (prev.some((a) => a.id === alert.id) ? prev : [alert, ...prev]));
        setLiveToastAlert(alert);
      }
    } finally {
      setCheckingId(null);
    }
  }

  async function handleUpdateProduct(
    id: string,
    patch: Partial<{ targetPrice: number | null; checkIntervalHours: number }>
  ) {
    const { product: updated } = await updateTrackedProduct(id, patch);
    setProducts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }

  async function handleRecordPrice(id: string, price: number) {
    const { product: updated, alert } = await recordManualProductPrice(id, price);
    setProducts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    if (alert) {
      setAlerts((prev) => (prev.some((a) => a.id === alert.id) ? prev : [alert, ...prev]));
      setLiveToastAlert(alert);
    }
  }

  async function handleDeleteProduct(product: TrackedProduct) {
    await deleteTrackedProduct(product.id);
    setProducts((prev) => prev.filter((p) => p.id !== product.id));
    if (selectedProductId === product.id) {
      setSelectedProductId(null);
    }
  }

  async function handleSaveSettings(nextSettings: AlertSettings, applyToAll: boolean = false) {
    const res = await saveAlertSettings(nextSettings, applyToAll);
    setSettings(res.settings);
    setProducts(res.products);
    setCapabilities(res.capabilities);
  }

  async function handleSendTest(channel?: 'email' | 'telegram' | 'push') {
    const { alert } = await sendTestNotification(channel);
    setAlerts((prev) => (prev.some((a) => a.id === alert.id) ? prev : [alert, ...prev]));
    setLiveToastAlert(alert);
  }

  async function handleDeleteAlert(alert: AlertLogEntry) {
    await deleteAlertLog(alert.id);
    setAlerts((prev) => prev.filter((a) => a.id !== alert.id));
    if (liveToastAlert?.id === alert.id) {
      setLiveToastAlert(null);
    }
  }

  async function handleClearAlerts() {
    await clearAllAlertLogs();
    setAlerts([]);
    setLiveToastAlert(null);
  }

  async function handleRunScheduleCycle() {
    setRunningCycle(true);
    try {
      const res = await runScheduleCheckNow();
      setProducts(res.products);
      if (res.alerts.length > 0) {
        setAlerts((prev) => {
          const existingIds = new Set(prev.map((a) => a.id));
          const fresh = res.alerts.filter((a) => !existingIds.has(a.id));
          return [...fresh, ...prev];
        });
        setLiveToastAlert(res.alerts[0]);
      }
    } finally {
      setRunningCycle(false);
    }
  }

  const selectedProduct = products.find((p) => p.id === selectedProductId) || null;

  if (authChecking) {
    return (
      <div
        aria-busy="true"
        aria-label="Checking session"
        className="min-h-screen bg-[#F8FAFC] flex items-center justify-center px-4"
      >
        <div className="w-full max-w-sm h-64 bg-white border border-slate-200 rounded-2xl animate-pulse" />
      </div>
    );
  }

  if (!authUsername) {
    return (
      <LoginWall
        configured={authConfigured}
        initialNotice={authNotice}
        onAuthenticated={handleAuthenticated}
      />
    );
  }

  return (
    <div className="min-h-screen flex bg-[#F8FAFC] text-[#0F172A]">
      <Sidebar
        activeSection={activeSection}
        onSelectSection={(sec) => setActiveSection(sec)}
        productCount={products.length}
        alertCount={alerts.length}
        settings={settings}
        username={authUsername}
        onSignOut={handleSignOut}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />

      <div className="flex-1 min-w-0 flex flex-col overflow-x-hidden">
        {/* Top Bar */}
        <header className="h-16 bg-white border-b border-slate-200 px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-2 sm:gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900 rounded-md cursor-pointer shrink-0"
            >
              <Menu className="w-5 h-5" />
            </button>
            <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm min-w-0">
              <span className="hidden sm:inline font-display font-semibold text-slate-500 whitespace-nowrap">
                PricePulse
              </span>
              <span className="hidden sm:inline text-slate-300" aria-hidden="true">
                /
              </span>
              <h1 className="font-display font-semibold text-slate-900 truncate">
                {SECTION_TITLES[activeSection]}
              </h1>
            </nav>
          </div>
        </header>

        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 max-w-[1200px] w-full mx-auto space-y-6">
          {loading ? (
            <div className="space-y-6" aria-busy="true" aria-label="Loading tracked products">
              <div className="h-32 bg-white border border-slate-200 rounded-xl animate-pulse" />
              <div className="h-24 bg-white border border-slate-200 rounded-xl animate-pulse" />
              <div className="h-72 bg-white border border-slate-200 rounded-xl animate-pulse" />
            </div>
          ) : loadError ? (
            <div
              role="alert"
              className="bg-white border border-red-200 rounded-xl p-6 text-center space-y-3"
            >
              <p className="font-display text-base font-semibold text-slate-900">
                Could not connect to PricePulse server
              </p>
              <p className="text-sm text-slate-600">{loadError}</p>
              <button
                type="button"
                onClick={loadData}
                className="px-4 py-2 text-sm font-medium bg-blue-700 hover:bg-blue-800 text-white rounded-lg cursor-pointer"
              >
                Retry
              </button>
            </div>
          ) : (
            <>
              {activeSection === 'watchlist' && (
                <>
                  <TrackProductBar
                    defaultIntervalHours={settings.defaultCheckIntervalHours}
                    inputRef={trackInputRef}
                    onProductAdded={handleProductAdded}
                  />

                  {selectedProduct && (
                    <ProductDetailPanel
                      product={selectedProduct}
                      checking={checkingId === selectedProduct.id}
                      onClose={() => setSelectedProductId(null)}
                      onCheckNow={handleCheckNow}
                      onUpdateProduct={handleUpdateProduct}
                      onRecordPrice={handleRecordPrice}
                    />
                  )}

                  <WatchlistView
                    products={products}
                    selectedProductId={selectedProductId}
                    checkingId={checkingId}
                    onSelectProduct={(p) =>
                      setSelectedProductId((curr) => (curr === p.id ? null : p.id))
                    }
                    onCheckNow={handleCheckNow}
                    onDeleteProduct={handleDeleteProduct}
                    onFocusTrackInput={focusTrackProductBar}
                  />
                </>
              )}

              {activeSection === 'alerts' && (
                <AlertsHistoryView
                  alerts={alerts}
                  onGoToSetup={() => setActiveSection('setup')}
                  onDeleteAlert={handleDeleteAlert}
                  onClearAlerts={handleClearAlerts}
                />
              )}

              {activeSection === 'setup' && (
                <AlertSetupView
                  settings={settings}
                  capabilities={capabilities}
                  onSaveSettings={(next) => handleSaveSettings(next, false)}
                  onSendTest={handleSendTest}
                />
              )}

              {activeSection === 'schedule' && (
                <ScheduleView
                  settings={settings}
                  products={products}
                  runningCycle={runningCycle}
                  onSaveDefaultInterval={(hours, applyToAll) =>
                    handleSaveSettings(
                      { ...settings, defaultCheckIntervalHours: hours },
                      applyToAll
                    )
                  }
                  onUpdateProductInterval={(id, hours) =>
                    handleUpdateProduct(id, { checkIntervalHours: hours })
                  }
                  onRunCycleNow={handleRunScheduleCycle}
                />
              )}
            </>
          )}
        </main>
      </div>

      <PushToastBanner
        alert={liveToastAlert}
        onDismiss={() => setLiveToastAlert(null)}
        onViewAlerts={() => {
          setLiveToastAlert(null);
          setActiveSection('alerts');
        }}
      />
    </div>
  );
}
