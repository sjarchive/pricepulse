import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ExternalLink, RefreshCw, X } from 'lucide-react';
import {
  formatCompactCurrency,
  formatCountdown,
  formatCurrency,
  formatRelativeTime,
  sanitizeExternalUrl,
  validateCheckInterval,
} from '../lib/priceUtils';
import type { AlertLogEntry, TrackedProduct } from '../types/tracker';
import { ProductThumbnail } from './ProductThumbnail';

interface ProductDetailPanelProps {
  product: TrackedProduct;
  checking: boolean;
  nowMs: number;
  onClose: () => void;
  onCheckNow: (product: TrackedProduct) => Promise<{ product: TrackedProduct; alert: AlertLogEntry | null }>;
  onUpdateProduct: (
    id: string,
    patch: { targetPrice: number | null; checkIntervalHours: number }
  ) => Promise<void>;
  onRecordPrice: (id: string, price: number) => Promise<AlertLogEntry | null>;
}

export function ProductDetailPanel({
  product,
  checking,
  nowMs,
  onClose,
  onCheckNow,
  onUpdateProduct,
  onRecordPrice,
}: ProductDetailPanelProps) {
  const [targetInput, setTargetInput] = useState(
    product.targetPrice !== null ? String(product.targetPrice) : ''
  );
  const [intervalInput, setIntervalInput] = useState(String(product.checkIntervalHours));
  const [manualPriceInput, setManualPriceInput] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [recordingPrice, setRecordingPrice] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    setTargetInput(product.targetPrice !== null ? String(product.targetPrice) : '');
    setIntervalInput(String(product.checkIntervalHours));
    setManualPriceInput('');
    setFeedback(null);
  }, [product.id, product.targetPrice, product.checkIntervalHours]);

  const chartData = useMemo(() => {
    const timestamps = product.history
      .map((p) => Date.parse(p.timestamp))
      .filter((ms) => !Number.isNaN(ms));
    const spanMs =
      timestamps.length >= 2
        ? Math.max(...timestamps) - Math.min(...timestamps)
        : 0;
    const isShortSpan = spanMs <= 48 * 60 * 60 * 1000;
    const uniqueDays = new Set(
      product.history.map((p) => new Date(p.timestamp).toDateString())
    ).size;

    return product.history.map((point) => {
      const dt = new Date(point.timestamp);
      const label = isShortSpan
        ? uniqueDays <= 1
          ? dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
          : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' })
        : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return {
        label,
        fullTime: `${dt.toLocaleDateString('en-GB', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        })}, ${dt.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        })}`,
        price: point.price,
      };
    });
  }, [product.history]);

  const avgPrice = useMemo(() => {
    if (product.history.length === 0) return product.currentPrice;
    const sum = product.history.reduce((acc, p) => acc + p.price, 0);
    return Number((sum / product.history.length).toFixed(2));
  }, [product.history, product.currentPrice]);

  async function handleSaveTracking(e: FormEvent) {
    e.preventDefault();
    setFeedback(null);

    const intervalCheck = validateCheckInterval(Number(intervalInput));
    if (!intervalCheck.valid) {
      setFeedback({ type: 'err', text: intervalCheck.error || 'Minimum interval is 1 hour.' });
      return;
    }

    let parsedTarget: number | null = null;
    if (targetInput.trim() !== '') {
      const val = Number(targetInput);
      if (!Number.isFinite(val) || val <= 0) {
        setFeedback({ type: 'err', text: 'Target price must be greater than 0.' });
        return;
      }
      parsedTarget = val;
    }

    setSavingSettings(true);
    try {
      await onUpdateProduct(product.id, {
        targetPrice: parsedTarget,
        checkIntervalHours: intervalCheck.value,
      });
      setFeedback({ type: 'ok', text: 'Tracking interval and target price updated.' });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Failed to update product settings.',
      });
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleCheckLiveNow() {
    setFeedback(null);
    try {
      const { product: updated, alert } = await onCheckNow(product);
      if (alert) {
        setFeedback({
          type: 'ok',
          text: 'Live price drop detected — instant alerts dispatched to your enabled channels.',
        });
      } else if (updated.lastCheckStatus === 'ok') {
        setFeedback({
          type: 'ok',
          text: updated.lastCheckNote || 'Live price checked successfully.',
        });
      } else {
        setFeedback({
          type: 'err',
          text:
            updated.lastCheckNote ||
            'Could not extract a live price from this store right now. You can record an observed price below.',
        });
      }
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Failed to check live price.',
      });
    }
  }

  async function handleRecordObservedPrice(e: FormEvent) {
    e.preventDefault();
    setFeedback(null);
    const val = Number(manualPriceInput);
    if (!Number.isFinite(val) || val <= 0) {
      setFeedback({ type: 'err', text: 'Enter a valid observed price greater than 0.' });
      return;
    }

    const previousPrice = product.currentPrice;
    setRecordingPrice(true);
    try {
      const alert = await onRecordPrice(product.id, val);
      setManualPriceInput('');
      setFeedback({
        type: 'ok',
        text: alert
          ? 'Price drop recorded — instant alerts dispatched to your enabled channels.'
          : val < previousPrice
            ? 'Lower price recorded to history. No alert fired under your current alert trigger rules.'
            : 'New price point logged to history.',
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Failed to log price.',
      });
    } finally {
      setRecordingPrice(false);
    }
  }

  const safeHref = sanitizeExternalUrl(product.url);

  return (
    <section
      aria-label={`Price history and controls for ${product.title}`}
      className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 md:p-6 space-y-6"
    >
      {/* Top Product Header */}
      <div className="flex items-start justify-between gap-3 pb-5 border-b border-slate-200">
        <div className="flex items-start gap-3 sm:gap-4 min-w-0">
          <ProductThumbnail
            src={product.imageUrl}
            alt={product.title}
            platformLabel={product.platformLabel}
            size="lg"
          />
          <div className="min-w-0">
            <p className="text-xs text-slate-500 leading-relaxed">
              <span className="font-medium text-slate-700">{product.platformLabel}</span>
              {' · '}
              <span>Last checked {formatRelativeTime(product.lastCheckedAt, nowMs)}</span>
              {' · '}
              <span>Next check {formatCountdown(product.nextCheckAt, nowMs)}</span>
            </p>
            <h3 className="font-display text-base sm:text-lg font-semibold text-slate-900 mt-1 leading-snug break-words selectable-text">
              {product.title}
            </h3>
            <div className="mt-2.5 flex flex-wrap items-center gap-4 text-xs">
              <button
                type="button"
                onClick={handleCheckLiveNow}
                disabled={checking}
                className="inline-flex items-center gap-1.5 font-medium text-blue-700 hover:text-blue-800 disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} />
                {checking ? 'Checking store...' : 'Check live price now'}
              </button>
              {safeHref && (
                <a
                  href={safeHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-900"
                >
                  Open on {product.platformLabel}
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close product detail panel"
          className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg cursor-pointer shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Price Stat Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pb-5 border-b border-slate-200">
        <div className="min-w-0">
          <p className="text-xs text-slate-500">Current Price</p>
          <p className="mt-1 font-mono text-lg sm:text-xl font-semibold tabular-nums text-slate-900 truncate selectable-text">
            {formatCurrency(product.currentPrice, product.currency)}
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-xs text-slate-500">All-Time Low</p>
          <p className="mt-1 font-mono text-lg sm:text-xl font-semibold tabular-nums text-emerald-700 truncate selectable-text">
            {formatCurrency(product.lowestPrice, product.currency)}
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-xs text-slate-500">Average Price</p>
          <p className="mt-1 font-mono text-lg sm:text-xl font-semibold tabular-nums text-slate-700 truncate selectable-text">
            {formatCurrency(avgPrice, product.currency)}
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-xs text-slate-500">All-Time High</p>
          <p className="mt-1 font-mono text-lg sm:text-xl font-semibold tabular-nums text-slate-700 truncate selectable-text">
            {formatCurrency(product.highestPrice, product.currency)}
          </p>
        </div>
      </div>

      {/* Price History Chart */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold text-slate-900">Price History</h4>
          {product.targetPrice !== null && (
            <span className="text-xs font-mono tabular-nums text-emerald-700">
              Target line: {formatCurrency(product.targetPrice, product.currency)}
            </span>
          )}
        </div>
        <div className="h-56 w-full select-none">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={chartData}
              accessibilityLayer={false}
              margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#1D4ED8" stopOpacity={0.14} />
                  <stop offset="95%" stopColor="#1D4ED8" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: '#64748B' }}
                axisLine={{ stroke: '#E2E8F0' }}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: '#64748B' }}
                axisLine={false}
                tickLine={false}
                width={72}
                domain={['auto', 'auto']}
                tickFormatter={(val: number) => formatCompactCurrency(val, product.currency)}
              />
              <Tooltip
                cursor={{ stroke: '#94A3B8', strokeWidth: 1, strokeDasharray: '4 4' }}
                formatter={(value) => [
                  formatCurrency(Number(value), product.currency),
                  'Price',
                ]}
                labelFormatter={(_label, payload) =>
                  payload?.[0]?.payload?.fullTime || String(_label)
                }
                contentStyle={{
                  backgroundColor: '#0F172A',
                  border: 'none',
                  borderRadius: '8px',
                  color: '#F8FAFC',
                  fontSize: '12px',
                }}
              />
              {product.targetPrice !== null && (
                <ReferenceLine
                  y={product.targetPrice}
                  stroke="#16A34A"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                />
              )}
              <Area
                type="monotone"
                dataKey="price"
                stroke="#1D4ED8"
                strokeWidth={2}
                fill="url(#priceFill)"
                animationDuration={220}
                dot={chartData.length <= 2 ? { r: 3.5, fill: '#1D4ED8', strokeWidth: 0 } : false}
                activeDot={{ r: 4, fill: '#1D4ED8' }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        {product.lastCheckNote && (
          <p className="mt-2 text-xs text-slate-500 selectable-text">Latest note: {product.lastCheckNote}</p>
        )}
      </div>

      {feedback && (
        <p
          role={feedback.type === 'err' ? 'alert' : 'status'}
          className={`text-sm rounded-lg px-3.5 py-2.5 border ${
            feedback.type === 'err'
              ? 'bg-red-50 border-red-200 text-red-700'
              : 'bg-emerald-50 border-emerald-200 text-emerald-800'
          }`}
        >
          {feedback.text}
        </p>
      )}

      {/* Controls Grid: Alert Rules & Manual Price Update */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-5 border-t border-slate-200">
        <form onSubmit={handleSaveTracking} className="space-y-3">
          <h4 className="text-sm font-semibold text-slate-900">Product Schedule &amp; Target</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="detail-target-price" className="block text-xs font-medium text-slate-700 mb-1">
                Target Alert Price ({product.currency})
              </label>
              <input
                id="detail-target-price"
                type="number"
                step="0.01"
                min="0.01"
                value={targetInput}
                onChange={(e) => setTargetInput(e.target.value)}
                placeholder="Any drop"
                className="w-full h-9 px-3 text-sm font-mono tabular-nums text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600"
              />
            </div>
            <div>
              <label htmlFor="detail-check-interval" className="block text-xs font-medium text-slate-700 mb-1">
                Check Every (min 1h)
              </label>
              <input
                id="detail-check-interval"
                type="number"
                min="1"
                max="720"
                step="1"
                value={intervalInput}
                onChange={(e) => setIntervalInput(e.target.value)}
                className="w-full h-9 px-3 text-sm font-mono tabular-nums text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={savingSettings}
            className="w-full sm:w-auto h-9 px-4 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-xs font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            {savingSettings ? 'Saving...' : 'Save Product Rules'}
          </button>
        </form>

        <form onSubmit={handleRecordObservedPrice} className="space-y-3">
          <h4 className="text-sm font-semibold text-slate-900">Record Observed Price</h4>
          <p className="text-xs text-slate-500">
            Log a lower price you spotted (or test your instant Email, Telegram &amp; Push drop alert).
          </p>
          <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
            <label htmlFor="detail-manual-price" className="sr-only">
              Observed Price
            </label>
            <input
              id="detail-manual-price"
              type="number"
              step="0.01"
              min="0.01"
              value={manualPriceInput}
              onChange={(e) => setManualPriceInput(e.target.value)}
              placeholder={`e.g. ${Math.max(1, Math.round(product.currentPrice * 0.9))}`}
              className="w-full sm:flex-1 min-w-0 h-9 px-3 text-sm font-mono tabular-nums text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600"
            />
            <button
              type="submit"
              disabled={recordingPrice}
              className="w-full sm:w-auto h-9 px-4 bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {recordingPrice ? 'Updating...' : 'Update Price'}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
