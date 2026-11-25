import { useCallback, useEffect, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';
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
import { consumeInitialAppState, type InitialAppState } from './lib/initialState';
import { MOTION_DURATION_MS } from './lib/motion';
import type {
  AlertLogEntry,
  AlertSettings,
  BootstrapResponse,
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

const DEFAULT_CAPABILITIES: ServerCapabilities = {
  emailConfigured: false,
  telegramBotConfigured: false,
};

let cachedBootState: InitialAppState | null | undefined = undefined;
function getBootInitialState(): InitialAppState | null {
  if (cachedBootState === undefined) {
    cachedBootState = consumeInitialAppState();
  }
  return cachedBootState;
}

export default function App() {
  const bootState = getBootInitialState();
  const hasHydratedState = Boolean(
    bootState &&
      (!bootState.auth.authenticated ||
        (bootState.auth.username && bootState.bootstrap !== null))
  );

  const [authChecking, setAuthChecking] = useState(!hasHydratedState);
  const [authConfigured, setAuthConfigured] = useState(
    bootState ? bootState.auth.configured : true
  );
  const [authUsername, setAuthUsername] = useState<string | null>(
    hasHydratedState && bootState?.auth.authenticated ? bootState.auth.username : null
  );
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  const [activeSection, setActiveSection] = useState<NavSection>('watchlist');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [retryingLoad, setRetryingLoad] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [products, setProducts] = useState<TrackedProduct[]>(
    hasHydratedState && bootState?.bootstrap ? bootState.bootstrap.products : []
  );
  const [settings, setSettings] = useState<AlertSettings>(
    hasHydratedState && bootState?.bootstrap ? bootState.bootstrap.settings : DEFAULT_SETTINGS
  );
  const [alerts, setAlerts] = useState<AlertLogEntry[]>(
    hasHydratedState && bootState?.bootstrap ? bootState.bootstrap.alerts : []
  );
  const [capabilities, setCapabilities] = useState<ServerCapabilities>(
    hasHydratedState && bootState?.bootstrap
      ? bootState.bootstrap.capabilities
      : DEFAULT_CAPABILITIES
  );

  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [runningCycle, setRunningCycle] = useState(false);
  const [liveToastAlert, setLiveToastAlert] = useState<AlertLogEntry | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const trackInputRef = useRef<HTMLInputElement | null>(null);
  const notifiedAlertIdsRef = useRef<Set<string>>(new Set());
  const hasNavigatedRef = useRef(false);
  const [renderedDetailProduct, setRenderedDetailProduct] = useState<TrackedProduct | null>(null);

  const notifyAlert = useCallback((alert: AlertLogEntry, showOsPush: boolean = true) => {
    if (notifiedAlertIdsRef.current.has(alert.id)) return;
    notifiedAlertIdsRef.current.add(alert.id);
    setLiveToastAlert(alert);
    if (showOsPush) {
      const pushEnabled = alert.deliveries.some(
        (d) => d.channel === 'push' && d.status !== 'disabled'
      );
      if (pushEnabled) {
        showBrowserPushNotification(alert.productTitle, alert.message, alert.productUrl);
      }
    }
  }, []);

  const clearProtectedState = useCallback(() => {
    setAuthUsername(null);
    setProducts([]);
    setAlerts([]);
    setSettings(DEFAULT_SETTINGS);
    setSelectedProductId(null);
    setLiveToastAlert(null);
    setLoadError(null);
    setActionError(null);
    notifiedAlertIdsRef.current.clear();
    setActiveSection('watchlist');
  }, []);

  const applyBootstrap = useCallback((data: BootstrapResponse) => {
    setProducts(data.products);
    setSettings(data.settings);
    setAlerts(data.alerts);
    setCapabilities(data.capabilities);
    setLoadError(null);
  }, []);

  const loadData = useCallback(async () => {
    setRetryingLoad(true);
    try {
      const data = await fetchBootstrap();
      applyBootstrap(data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Unable to load watchlist data.');
    } finally {
      setRetryingLoad(false);
    }
  }, [applyBootstrap]);

  useEffect(() => {
    setUnauthorizedListener(() => {
      setAuthNotice('Your session expired. Please sign in again.');
      clearProtectedState();
    });
    return () => setUnauthorizedListener(null);
  }, [clearProtectedState]);

  useEffect(() => {
    registerPushServiceWorker();
    if (hasHydratedState) return;

    let active = true;
    (async () => {
      try {
        const status = await fetchAuthStatus({ includeBootstrap: true });
        if (!active) return;
        setAuthConfigured(status.configured);
        if (status.authenticated && status.username) {
          try {
            const data = status.bootstrap ?? (await fetchBootstrap());
            if (!active) return;
            applyBootstrap(data);
          } catch (err) {
            if (!active) return;
            setLoadError(
              err instanceof Error ? err.message : 'Unable to load watchlist data.'
            );
          }
          setAuthUsername(status.username);
        }
      } catch {
        if (active) setAuthConfigured(true);
      } finally {
        if (active) setAuthChecking(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [applyBootstrap, hasHydratedState]);

  useEffect(() => {
    if (!authUsername) return;
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 30_000);
    return () => clearInterval(timer);
  }, [authUsername]);

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
          setSettings(fresh.settings);
          setCapabilities(fresh.capabilities);
          setAlerts((prev) => {
            const existing = new Set([
              ...prev.map((a) => a.id),
              ...seenIds,
              ...notifiedAlertIdsRef.current,
            ]);
            const newest = fresh.alerts.find((a) => !existing.has(a.id));
            if (newest) {
              seenIds.add(newest.id);
              notifyAlert(newest, true);
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
                notifyAlert(payload.alert, true);
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
  }, [authUsername, notifyAlert]);

  async function handleAuthenticated(
    token: string,
    username: string,
    bootstrap?: BootstrapResponse
  ) {
    setAuthToken(token);
    const data = bootstrap ?? (await fetchBootstrap());
    applyBootstrap(data);
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

  async function handleCheckNow(
    product: TrackedProduct
  ): Promise<{ product: TrackedProduct; alert: AlertLogEntry | null }> {
    setActionError(null);
    setCheckingId(product.id);
    try {
      const result = await checkProductPriceNow(product.id);
      setProducts((prev) => prev.map((p) => (p.id === result.product.id ? result.product : p)));
      setNowMs(Date.now());
      if (result.alert) {
        setAlerts((prev) =>
          prev.some((a) => a.id === result.alert!.id) ? prev : [result.alert!, ...prev]
        );
        notifyAlert(result.alert, true);
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to check product price.';
      setActionError(msg);
      throw err;
    } finally {
      setCheckingId(null);
    }
  }

  async function handleUpdateProduct(
    id: string,
    patch: Partial<{ targetPrice: number | null; checkIntervalHours: number }>
  ) {
    setActionError(null);
    const { product: updated } = await updateTrackedProduct(id, patch);
    setProducts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    setNowMs(Date.now());
  }

  async function handleRecordPrice(id: string, price: number): Promise<AlertLogEntry | null> {
    setActionError(null);
    const { product: updated, alert } = await recordManualProductPrice(id, price);
    setProducts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    setNowMs(Date.now());
    if (alert) {
      setAlerts((prev) => (prev.some((a) => a.id === alert.id) ? prev : [alert, ...prev]));
      notifyAlert(alert, true);
    }
    return alert;
  }

  async function handleDeleteProduct(product: TrackedProduct) {
    setActionError(null);
    try {
      await deleteTrackedProduct(product.id);
      setProducts((prev) => prev.filter((p) => p.id !== product.id));
      if (selectedProductId === product.id) {
        setSelectedProductId(null);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to remove product.');
    }
  }

  async function handleSaveSettings(nextSettings: AlertSettings, applyToAll: boolean = false) {
    setActionError(null);
    const res = await saveAlertSettings(nextSettings, applyToAll);
    setSettings(res.settings);
    setProducts(res.products);
    setCapabilities(res.capabilities);
    setNowMs(Date.now());
  }

  async function handleSendTest(channel?: 'email' | 'telegram' | 'push'): Promise<AlertLogEntry> {
    const { alert } = await sendTestNotification(channel);
    setAlerts((prev) => (prev.some((a) => a.id === alert.id) ? prev : [alert, ...prev]));
    const hasDelivered = alert.deliveries.some(
      (d) => d.status === 'sent' || d.status === 'logged'
    );
    if (hasDelivered) {
      notifyAlert(alert, false);
    }
    return alert;
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

  async function handleRunScheduleCycle(): Promise<{ checkedCount: number; alertsCount: number }> {
    setActionError(null);
    setRunningCycle(true);
    try {
      const res = await runScheduleCheckNow();
      setProducts(res.products);
      setNowMs(Date.now());
      if (res.alerts.length > 0) {
        setAlerts((prev) => {
          const existingIds = new Set(prev.map((a) => a.id));
          const fresh = res.alerts.filter((a) => !existingIds.has(a.id));
          return [...fresh, ...prev];
        });
        notifyAlert(res.alerts[0], true);
      }
      return { checkedCount: res.checkedCount, alertsCount: res.alerts.length };
    } finally {
      setRunningCycle(false);
    }
  }

  const selectedProduct = products.find((p) => p.id === selectedProductId) || null;

  useEffect(() => {
    if (selectedProduct) {
      setRenderedDetailProduct(selectedProduct);
      return;
    }
    const timer = setTimeout(() => {
      setRenderedDetailProduct(null);
    }, MOTION_DURATION_MS.slow);
    return () => clearTimeout(timer);
  }, [selectedProduct]);

  function handleSelectSection(next: NavSection) {
    if (next !== activeSection) {
      hasNavigatedRef.current = true;
      setActiveSection(next);
    }
  }

  if (authChecking) {
    return (
      <div
        aria-busy="true"
        aria-label="Loading PricePulse"
        className="min-h-screen bg-[#F8FAFC]"
      />
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
        onSelectSection={handleSelectSection}
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
          {loadError ? (
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
                disabled={retryingLoad}
                className="px-4 py-2 text-sm font-medium bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white rounded-lg cursor-pointer"
              >
                {retryingLoad ? 'Retrying...' : 'Retry'}
              </button>
            </div>
          ) : (
            <>
              {actionError && (
                <div
                  role="alert"
                  className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm flex items-center justify-between gap-3 pp-feedback-enter"
                >
                  <span>{actionError}</span>
                  <button
                    type="button"
                    onClick={() => setActionError(null)}
                    aria-label="Dismiss error message"
                    className="p-1 text-red-500 hover:text-red-800 rounded cursor-pointer shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              <div
                key={activeSection}
                className={hasNavigatedRef.current ? 'space-y-6 pp-view-enter' : 'space-y-6'}
              >
                {activeSection === 'watchlist' && (
                  <>
                    <div>
                      <TrackProductBar
                        defaultIntervalHours={settings.defaultCheckIntervalHours}
                        inputRef={trackInputRef}
                        onProductAdded={handleProductAdded}
                      />

                      <div
                        className="pp-collapse"
                        data-open={selectedProduct ? 'true' : 'false'}
                        aria-hidden={!selectedProduct}
                        inert={!selectedProduct}
                      >
                        <div className="pp-collapse-inner">
                          {renderedDetailProduct && (
                            <div className="pt-6">
                              <ProductDetailPanel
                                product={renderedDetailProduct}
                                checking={checkingId === renderedDetailProduct.id}
                                nowMs={nowMs}
                                onClose={() => setSelectedProductId(null)}
                                onCheckNow={handleCheckNow}
                                onUpdateProduct={handleUpdateProduct}
                                onRecordPrice={handleRecordPrice}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    <WatchlistView
                      products={products}
                      selectedProductId={selectedProductId}
                      checkingId={checkingId}
                      nowMs={nowMs}
                      onSelectProduct={(p) =>
                        setSelectedProductId((curr) => (curr === p.id ? null : p.id))
                      }
                      onCheckNow={(p) => {
                        handleCheckNow(p).catch(() => undefined);
                      }}
                      onDeleteProduct={handleDeleteProduct}
                      onFocusTrackInput={focusTrackProductBar}
                    />
                  </>
                )}

                {activeSection === 'alerts' && (
                  <AlertsHistoryView
                    alerts={alerts}
                    nowMs={nowMs}
                    onGoToSetup={() => handleSelectSection('setup')}
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
                    nowMs={nowMs}
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
              </div>
            </>
          )}
        </main>
      </div>

      <PushToastBanner
        alert={liveToastAlert}
        onDismiss={() => setLiveToastAlert(null)}
        onViewAlerts={() => {
          setLiveToastAlert(null);
          handleSelectSection('alerts');
        }}
      />
    </div>
  );
}
