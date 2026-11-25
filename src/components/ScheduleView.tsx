import { useEffect, useState, type FormEvent } from 'react';
import { Play } from 'lucide-react';
import {
  MIN_CHECK_INTERVAL_HOURS,
  formatCountdown,
  formatRelativeTime,
  validateCheckInterval,
} from '../lib/priceUtils';
import type { AlertSettings, TrackedProduct } from '../types/tracker';

interface ScheduleViewProps {
  settings: AlertSettings;
  products: TrackedProduct[];
  runningCycle: boolean;
  nowMs: number;
  onSaveDefaultInterval: (hours: number, applyToAll: boolean) => Promise<void>;
  onUpdateProductInterval: (id: string, hours: number) => Promise<void>;
  onRunCycleNow: () => Promise<{ checkedCount: number; alertsCount: number }>;
}

const PRESET_HOURS = [1, 2, 4, 6, 12, 24];

export function ScheduleView({
  settings,
  products,
  runningCycle,
  nowMs,
  onSaveDefaultInterval,
  onUpdateProductInterval,
  onRunCycleNow,
}: ScheduleViewProps) {
  const [hoursInput, setHoursInput] = useState(String(settings.defaultCheckIntervalHours));
  const [applyToAll, setApplyToAll] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updatingProductId, setUpdatingProductId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    setHoursInput(String(settings.defaultCheckIntervalHours));
  }, [settings.defaultCheckIntervalHours]);

  async function handleSaveGlobal(e: FormEvent) {
    e.preventDefault();
    setFeedback(null);
    const check = validateCheckInterval(Number(hoursInput));
    if (!check.valid) {
      setFeedback({ type: 'err', text: check.error || 'Minimum check interval is 1 hour.' });
      return;
    }

    setSaving(true);
    try {
      await onSaveDefaultInterval(check.value, applyToAll);
      setFeedback({
        type: 'ok',
        text: applyToAll
          ? `Default check interval set to every ${check.value} ${check.value === 1 ? 'hour' : 'hours'} and applied to all tracked products.`
          : `Default interval for newly added products set to every ${check.value} ${check.value === 1 ? 'hour' : 'hours'}.`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Failed to save schedule.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleRunCycle() {
    setFeedback(null);
    try {
      const { checkedCount, alertsCount } = await onRunCycleNow();
      setFeedback({
        type: 'ok',
        text:
          alertsCount > 0
            ? `Checked ${checkedCount} ${checkedCount === 1 ? 'product' : 'products'} and triggered ${alertsCount} price drop ${alertsCount === 1 ? 'alert' : 'alerts'}.`
            : `Checked ${checkedCount} ${checkedCount === 1 ? 'product' : 'products'}. No new price drops triggered alerts.`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Failed to run scheduled check cycle.',
      });
    }
  }

  async function handleProductIntervalChange(product: TrackedProduct, hours: number) {
    setFeedback(null);
    setUpdatingProductId(product.id);
    try {
      await onUpdateProductInterval(product.id, hours);
      setFeedback({
        type: 'ok',
        text: `Updated "${product.title}" to check every ${hours} ${hours === 1 ? 'hour' : 'hours'}.`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Failed to update product check interval.',
      });
    } finally {
      setUpdatingProductId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-slate-900">
            Price Check Schedule
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Set how often PricePulse checks product links automatically. Minimum interval is {MIN_CHECK_INTERVAL_HOURS} hour.
          </p>
        </div>

        <button
          type="button"
          onClick={handleRunCycle}
          disabled={runningCycle || products.length === 0}
          className="h-9 px-4 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white text-xs font-medium rounded-lg inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap w-full sm:w-auto cursor-pointer"
        >
          <Play className="w-3.5 h-3.5 shrink-0" />
          {runningCycle ? 'Checking All Products...' : 'Run Check Cycle Now'}
        </button>
      </div>

      {feedback && (
        <p
          role={feedback.type === 'err' ? 'alert' : 'status'}
          className={`text-sm rounded-lg px-4 py-3 border ${
            feedback.type === 'err'
              ? 'bg-red-50 border-red-200 text-red-700'
              : 'bg-emerald-50 border-emerald-200 text-emerald-800'
          }`}
        >
          {feedback.text}
        </p>
      )}

      {/* Global Default Interval Form */}
      <form
        onSubmit={handleSaveGlobal}
        className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 md:p-6 space-y-4"
      >
        <div>
          <h3 className="font-display text-base font-semibold text-slate-900">
            Default Polling Interval
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Choose a preset cadence or enter a custom hourly interval (1 to 720 hours).
          </p>
        </div>

        <div className="space-y-3">
          <div
            role="group"
            aria-label="Preset polling intervals"
            className="grid grid-cols-3 sm:grid-cols-6 gap-2 w-full"
          >
            {PRESET_HOURS.map((hrs) => {
              const isSelected = Number(hoursInput) === hrs;
              return (
                <button
                  key={hrs}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => {
                    setHoursInput(String(hrs));
                    setFeedback(null);
                  }}
                  className={`h-9 px-2 text-xs font-mono tabular-nums rounded-lg border transition-colors inline-flex items-center justify-center whitespace-nowrap cursor-pointer ${
                    isSelected
                      ? 'bg-blue-50 border-blue-600 text-blue-700 font-semibold'
                      : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                >
                  Every {hrs}h
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between sm:justify-start gap-3 pt-1">
            <label
              htmlFor="global-interval-hours"
              className="text-xs font-medium text-slate-700 whitespace-nowrap"
            >
              Custom interval (hours)
            </label>
            <div className="flex items-center gap-2">
              <input
                id="global-interval-hours"
                type="number"
                step="any"
                value={hoursInput}
                onChange={(e) => {
                  setHoursInput(e.target.value);
                  if (feedback) setFeedback(null);
                }}
                className="w-24 h-9 px-3 text-sm font-mono tabular-nums text-right sm:text-left text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600"
              />
              <span className="text-xs text-slate-500 whitespace-nowrap">hrs</span>
            </div>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2 border-t border-slate-100">
          <label className="inline-flex items-start sm:items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={applyToAll}
              onChange={(e) => setApplyToAll(e.target.checked)}
              className="w-4 h-4 mt-0.5 sm:mt-0 shrink-0 accent-blue-700 rounded"
            />
            <span>Apply this interval to all currently tracked products</span>
          </label>

          <button
            type="submit"
            disabled={saving}
            className="h-9 px-4 bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-xs font-medium rounded-lg transition-colors whitespace-nowrap w-full sm:w-auto cursor-pointer"
          >
            {saving ? 'Updating...' : 'Save Check Interval'}
          </button>
        </div>
      </form>

      {/* Per-Product Schedule */}
      <section
        aria-label="Per-product check intervals"
        className="bg-white border border-slate-200 rounded-xl overflow-hidden"
      >
        <div className="px-4 sm:px-5 py-4 border-b border-slate-200">
          <h3 className="font-display text-base font-semibold text-slate-900">
            Per-Product Schedule
          </h3>
        </div>

        {products.length === 0 ? (
          <p className="px-5 py-10 text-sm text-slate-500 text-center">
            No products scheduled yet. Add a product from your Watchlist to configure its check interval.
          </p>
        ) : (
          <>
            {/* Mobile stacked card layout — prevents column clipping and horizontal scroll */}
            <div className="md:hidden divide-y divide-slate-200">
              {products.map((product) => (
                <div key={product.id} className="p-4 space-y-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900 leading-snug break-words selectable-text">
                      {product.title}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">{product.platformLabel}</p>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor={`mobile-interval-${product.id}`}
                      className="text-xs font-medium text-slate-600"
                    >
                      Check Interval (min 1h)
                    </label>
                    <select
                      id={`mobile-interval-${product.id}`}
                      aria-label={`Check interval for ${product.title}`}
                      value={product.checkIntervalHours}
                      disabled={updatingProductId === product.id}
                      onChange={(e) => handleProductIntervalChange(product, Number(e.target.value))}
                      className="w-full h-9 px-3 text-xs font-mono tabular-nums text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600 disabled:opacity-60"
                    >
                      {PRESET_HOURS.map((hrs) => (
                        <option key={hrs} value={hrs}>
                          Every {hrs} {hrs === 1 ? 'hour' : 'hours'}
                        </option>
                      ))}
                      {!PRESET_HOURS.includes(product.checkIntervalHours) && (
                        <option value={product.checkIntervalHours}>
                          Every {product.checkIntervalHours} hours
                        </option>
                      )}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-100 text-xs">
                    <div>
                      <p className="text-slate-500">Last Checked</p>
                      <p className="font-mono tabular-nums text-slate-700 mt-0.5">
                        {formatRelativeTime(product.lastCheckedAt, nowMs)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-slate-500">Next Check</p>
                      <p className="font-mono tabular-nums font-medium text-slate-900 mt-0.5">
                        {formatCountdown(product.nextCheckAt, nowMs)}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop table layout */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                    <th className="py-3 pl-5 pr-4">Product</th>
                    <th className="py-3 px-4 whitespace-nowrap">Store</th>
                    <th className="py-3 px-4 whitespace-nowrap">Interval (min 1h)</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Last Checked</th>
                    <th className="py-3 pl-4 pr-5 text-right whitespace-nowrap">Next Check</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-sm">
                  {products.map((product) => (
                    <tr key={product.id} className="hover:bg-slate-50/70">
                      <td className="py-3 pl-5 pr-4 max-w-xs">
                        <p className="font-medium text-slate-900 truncate selectable-text">{product.title}</p>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600 whitespace-nowrap">
                        {product.platformLabel}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <select
                          aria-label={`Check interval for ${product.title}`}
                          value={product.checkIntervalHours}
                          disabled={updatingProductId === product.id}
                          onChange={(e) => handleProductIntervalChange(product, Number(e.target.value))}
                          className="h-8 px-2.5 text-xs font-mono tabular-nums text-slate-900 bg-white border border-slate-300 rounded-md focus:outline-none focus:border-blue-600 disabled:opacity-60"
                        >
                          {PRESET_HOURS.map((hrs) => (
                            <option key={hrs} value={hrs}>
                              Every {hrs} {hrs === 1 ? 'hour' : 'hours'}
                            </option>
                          ))}
                          {!PRESET_HOURS.includes(product.checkIntervalHours) && (
                            <option value={product.checkIntervalHours}>
                              Every {product.checkIntervalHours} hours
                            </option>
                          )}
                        </select>
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-xs tabular-nums text-slate-500 whitespace-nowrap">
                        {formatRelativeTime(product.lastCheckedAt, nowMs)}
                      </td>
                      <td className="py-3 pl-4 pr-5 text-right font-mono text-xs tabular-nums text-slate-900 whitespace-nowrap">
                        {formatCountdown(product.nextCheckAt, nowMs)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
