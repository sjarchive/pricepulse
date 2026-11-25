import { useMemo, useState } from 'react';
import { ExternalLink, Trash2 } from 'lucide-react';
import {
  formatCurrency,
  formatRelativeTime,
  sanitizeExternalUrl,
} from '../lib/priceUtils';
import type { AlertLogEntry, ChannelDeliveryResult } from '../types/tracker';

interface AlertsHistoryViewProps {
  alerts: AlertLogEntry[];
  nowMs: number;
  onGoToSetup: () => void;
  onDeleteAlert: (alert: AlertLogEntry) => Promise<void>;
  onClearAlerts: () => Promise<void>;
}

type AlertFilter = 'all' | 'price_drop' | 'test';

function deliveryStatusText(d: ChannelDeliveryResult): { label: string; className: string } {
  switch (d.status) {
    case 'sent':
      return { label: 'Delivered', className: 'text-emerald-700' };
    case 'logged':
      return { label: 'Recorded (configure env)', className: 'text-amber-700' };
    case 'failed':
      return { label: 'Failed', className: 'text-red-700' };
    default:
      return { label: 'Off', className: 'text-slate-400' };
  }
}

export function AlertsHistoryView({
  alerts,
  nowMs,
  onGoToSetup,
  onDeleteAlert,
  onClearAlerts,
}: AlertsHistoryViewProps) {
  const [filter, setFilter] = useState<AlertFilter>('all');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (filter === 'all') return alerts;
    return alerts.filter((a) => a.type === filter);
  }, [alerts, filter]);

  async function handleDeleteOne(entry: AlertLogEntry) {
    setErrorMsg(null);
    setDeletingId(entry.id);
    try {
      await onDeleteAlert(entry);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to delete alert log.');
    } finally {
      setDeletingId(null);
    }
  }

  async function handleConfirmClearAll() {
    setErrorMsg(null);
    setClearingAll(true);
    try {
      await onClearAlerts();
      setConfirmClearAll(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to clear alert logs.');
    } finally {
      setClearingAll(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-slate-900">
            Price Drops &amp; Alert Log
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Instant delivery history across Email, Telegram, and Browser Push notifications.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
          <div className="grid grid-cols-3 gap-1.5 w-full sm:w-auto sm:inline-flex sm:items-center sm:gap-1 sm:p-1 sm:bg-slate-100 sm:rounded-lg">
            {(
              [
                { id: 'all', label: 'All Alerts' },
                { id: 'price_drop', label: 'Price Drops' },
                { id: 'test', label: 'Test Alerts' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={`h-8 sm:h-auto px-2 sm:px-3 sm:py-1.5 text-xs font-medium rounded-lg sm:rounded-md border sm:border-0 transition-colors inline-flex items-center justify-center whitespace-nowrap truncate cursor-pointer ${
                  filter === tab.id
                    ? 'bg-blue-50 border-blue-600 text-blue-700 font-semibold sm:bg-white sm:text-slate-900 sm:shadow-xs sm:font-medium'
                    : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:text-slate-900 sm:bg-transparent'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {alerts.length > 0 && (
            confirmClearAll ? (
              <div className="inline-flex items-center gap-1.5 self-end sm:self-auto shrink-0 pp-feedback-enter">
                <button
                  type="button"
                  onClick={handleConfirmClearAll}
                  disabled={clearingAll}
                  className="h-8 px-3 text-xs font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                >
                  {clearingAll ? 'Clearing...' : 'Confirm Clear'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClearAll(false)}
                  disabled={clearingAll}
                  className="h-8 px-2.5 text-xs font-medium text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmClearAll(true)}
                className="h-8 px-3 text-xs font-medium text-slate-600 hover:text-red-700 bg-white hover:bg-red-50 border border-slate-200 hover:border-red-200 rounded-lg inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap self-end sm:self-auto shrink-0 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear All
              </button>
            )
          )}
        </div>
      </div>

      {errorMsg && (
        <p
          role="alert"
          className="text-sm rounded-lg px-4 py-3 border bg-red-50 border-red-200 text-red-700 pp-feedback-enter"
        >
          {errorMsg}
        </p>
      )}

      <section
        aria-label="Alert delivery history"
        className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200"
      >
        {filtered.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="font-display text-base font-semibold text-slate-900">
              No alerts recorded yet
            </p>
            <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
              When a tracked product drops in price—or when you send a test notification—delivery results appear here.
            </p>
            <button
              type="button"
              onClick={onGoToSetup}
              className="mt-4 px-4 py-2 text-sm font-medium bg-blue-700 hover:bg-blue-800 text-white rounded-lg cursor-pointer"
            >
              Configure Alert Channels
            </button>
          </div>
        ) : (
          filtered.map((entry) => {
            const safeHref = sanitizeExternalUrl(entry.productUrl);
            const isDeleting = deletingId === entry.id;
            return (
              <article key={entry.id} data-testid="alert-log-item" className="p-4 sm:p-5 space-y-3 transition-colors hover:bg-slate-50/60">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-slate-500">
                      <span className="font-medium text-slate-700">
                        {entry.type === 'price_drop' ? 'Price Drop Alert' : 'Test Notification'}
                      </span>
                      {' · '}
                      <span>{entry.platformLabel}</span>
                      {' · '}
                      <span className="font-mono tabular-nums">
                        {formatRelativeTime(entry.triggeredAt, nowMs)}
                      </span>
                    </p>
                    <h3 className="text-sm font-semibold text-slate-900 mt-1 break-words selectable-text">
                      {entry.productTitle}
                    </h3>
                    <p className="text-sm text-slate-600 mt-0.5 break-words selectable-text">{entry.message}</p>
                  </div>

                  <div className="flex items-start gap-2.5 shrink-0">
                    {entry.previousPrice !== null && entry.newPrice !== null && (
                      <div className="text-right selectable-text">
                        <p className="font-mono text-sm font-semibold tabular-nums text-emerald-700">
                          {formatCurrency(entry.newPrice, entry.currency)}
                        </p>
                        <p className="font-mono text-xs tabular-nums text-slate-400 line-through">
                          {formatCurrency(entry.previousPrice, entry.currency)}
                        </p>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => handleDeleteOne(entry)}
                      disabled={isDeleting || clearingAll}
                      aria-label={`Delete alert log for ${entry.productTitle}`}
                      title="Delete alert log"
                      className="w-8 h-8 inline-flex items-center justify-center text-slate-400 hover:text-red-700 bg-white hover:bg-red-50 border border-slate-200 hover:border-red-200 rounded-lg transition-colors disabled:opacity-50 cursor-pointer shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-100 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                  {entry.deliveries.map((d) => {
                    const statusInfo = deliveryStatusText(d);
                    return (
                      <div key={d.channel} className="space-y-0.5 min-w-0">
                        <p className="text-slate-700 font-medium capitalize">
                          {d.channel}{' '}
                          <span aria-hidden="true" className="text-slate-300">
                            ·
                          </span>{' '}
                          <span className={statusInfo.className}>{statusInfo.label}</span>
                        </p>
                        <p className="text-slate-500 leading-relaxed break-words selectable-text">{d.detail}</p>
                      </div>
                    );
                  })}
                </div>

                {safeHref && (
                  <div className="pt-1">
                    <a
                      href={safeHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-800"
                    >
                      Open product listing
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                )}
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}
