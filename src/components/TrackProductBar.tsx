import { useState, type FormEvent, type RefObject } from 'react';
import { ArrowRight, Link2, Loader2, X } from 'lucide-react';
import { createTrackedProduct, previewProductLink } from '../api/client';
import {
  MIN_CHECK_INTERVAL_HOURS,
  SUPPORTED_PLATFORMS,
  detectPlatform,
  formatCurrency,
  validateCheckInterval,
} from '../lib/priceUtils';
import type { CurrencyCode, TrackedProduct, UrlPreviewResult } from '../types/tracker';
import { ProductThumbnail } from './ProductThumbnail';

interface TrackProductBarProps {
  defaultIntervalHours: number;
  inputRef: RefObject<HTMLInputElement | null>;
  onProductAdded: (product: TrackedProduct) => void;
}

const INTERVAL_PRESETS = [1, 2, 4, 6, 12, 24];

export function TrackProductBar({
  defaultIntervalHours,
  inputRef,
  onProductAdded,
}: TrackProductBarProps) {
  const [urlInput, setUrlInput] = useState('');
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [preview, setPreview] = useState<UrlPreviewResult | null>(null);
  const [title, setTitle] = useState('');
  const [currentPrice, setCurrentPrice] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  const [currency, setCurrency] = useState<CurrencyCode>('INR');
  const [intervalHours, setIntervalHours] = useState(String(defaultIntervalHours));

  async function handleInspectUrl(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    const trimmed = urlInput.trim();
    if (!trimmed) {
      setErrorMsg('Paste a product link from Amazon, Flipkart, Myntra, or another store.');
      return;
    }

    setLoadingPreview(true);
    try {
      const result = await previewProductLink(trimmed);
      setPreview(result);
      setTitle(result.title);
      setCurrency(result.currency);
      setCurrentPrice(result.price !== null ? String(result.price) : '');
      setTargetPrice(
        result.price !== null ? String(Math.max(1, Math.round(result.price * 0.9))) : ''
      );
      setIntervalHours(String(Math.max(MIN_CHECK_INTERVAL_HOURS, defaultIntervalHours)));
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to inspect product URL.');
    } finally {
      setLoadingPreview(false);
    }
  }

  async function handleConfirmTrack(e: FormEvent) {
    e.preventDefault();
    if (!preview) return;
    setErrorMsg(null);

    const parsedPrice = Number(currentPrice);
    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      setErrorMsg('Enter a valid current price greater than 0.');
      return;
    }

    let parsedTarget: number | null = null;
    if (targetPrice.trim() !== '') {
      const numTarget = Number(targetPrice);
      if (!Number.isFinite(numTarget) || numTarget <= 0) {
        setErrorMsg('Target price must be a positive number or left blank.');
        return;
      }
      parsedTarget = numTarget;
    }

    const parsedInterval = Number(intervalHours);
    const intervalCheck = validateCheckInterval(parsedInterval);
    if (!intervalCheck.valid) {
      setErrorMsg(intervalCheck.error || 'Minimum check interval is 1 hour.');
      return;
    }

    if (title.trim().length < 2) {
      setErrorMsg('Enter a product title (at least 2 characters).');
      return;
    }

    setSubmitting(true);
    try {
      const { product } = await createTrackedProduct({
        url: preview.url,
        title: title.trim(),
        currentPrice: parsedPrice,
        targetPrice: parsedTarget,
        checkIntervalHours: intervalCheck.value,
        currency,
        imageUrl: preview.imageUrl,
      });
      onProductAdded(product);
      setUrlInput('');
      setPreview(null);
      setTitle('');
      setCurrentPrice('');
      setTargetPrice('');
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not save tracked product.');
    } finally {
      setSubmitting(false);
    }
  }

  function handleReset() {
    setPreview(null);
    setErrorMsg(null);
  }

  const detectedStore = urlInput.trim() ? detectPlatform(urlInput.trim()) : null;

  return (
    <section
      aria-label="Track new product"
      className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 md:p-6"
    >
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-2 mb-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900">
            Track a Product Link
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Paste a link from Amazon, Flipkart, Myntra, Ajio, Croma, Nykaa, Walmart, Best Buy, or any online store.
          </p>
        </div>
        <p className="text-xs text-slate-500 md:whitespace-nowrap">
          Supported: {SUPPORTED_PLATFORMS.slice(0, 6).map((p) => p.label).join(' · ')} &amp; more
        </p>
      </div>

      <form onSubmit={handleInspectUrl} className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 min-w-0">
          <label htmlFor="product-url-input" className="sr-only">
            Product URL
          </label>
          <Link2 className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            ref={inputRef}
            id="product-url-input"
            type="text"
            value={urlInput}
            onChange={(e) => {
              setUrlInput(e.target.value);
              if (errorMsg) setErrorMsg(null);
            }}
            placeholder="https://www.amazon.in/dp/... or https://www.flipkart.com/..."
            className="w-full h-11 pl-10 pr-4 text-sm text-slate-900 placeholder:text-slate-400 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15 transition-colors"
          />
        </div>
        <button
          type="submit"
          disabled={loadingPreview}
          className="h-11 px-5 bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-sm font-medium rounded-lg inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          {loadingPreview ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Fetching price
            </>
          ) : (
            <>
              Fetch Product
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>

      {detectedStore && !preview && !errorMsg && (
        <p className="mt-2.5 text-xs text-slate-500">
          Detected platform: <span className="font-medium text-slate-700">{detectedStore.platformLabel}</span>
          {' · '}Default currency: <span className="font-mono">{detectedStore.currency}</span>
        </p>
      )}

      {errorMsg && (
        <p role="alert" className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3.5 py-2.5">
          {errorMsg}
        </p>
      )}

      {preview && (
        <form
          onSubmit={handleConfirmTrack}
          className="mt-5 pt-5 border-t border-slate-200 space-y-4"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3.5 min-w-0">
              <ProductThumbnail
                src={preview.imageUrl}
                alt={title || preview.title}
                platformLabel={preview.platformLabel}
                size="md"
              />
              <div className="min-w-0">
                <p className="text-xs text-slate-500">
                  <span className="font-medium text-slate-700">{preview.platformLabel}</span>
                  {' · '}
                  <span>
                    {preview.fetchStatus === 'extracted'
                      ? 'Live price extracted'
                      : preview.fetchStatus === 'partial'
                        ? 'Confirm current price'
                        : 'Manual price confirmation needed'}
                  </span>
                </p>
                <p className="text-xs text-slate-500 mt-1">{preview.note}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleReset}
              aria-label="Cancel product preview"
              className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
            <div className="md:col-span-6">
              <label htmlFor="preview-title" className="block text-xs font-medium text-slate-700 mb-1.5">
                Product Title
              </label>
              <input
                id="preview-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                className="w-full h-10 px-3 text-sm text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15"
              />
            </div>

            <div className="md:col-span-2">
              <label htmlFor="preview-currency" className="block text-xs font-medium text-slate-700 mb-1.5">
                Currency
              </label>
              <select
                id="preview-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
                className="w-full h-10 px-3 text-sm font-mono text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600"
              >
                <option value="INR">INR (₹)</option>
                <option value="USD">USD ($)</option>
                <option value="GBP">GBP (£)</option>
                <option value="EUR">EUR (€)</option>
              </select>
            </div>

            <div className="md:col-span-2">
              <label htmlFor="preview-current-price" className="block text-xs font-medium text-slate-700 mb-1.5">
                Current Price
              </label>
              <input
                id="preview-current-price"
                type="number"
                step="0.01"
                min="0.01"
                value={currentPrice}
                onChange={(e) => setCurrentPrice(e.target.value)}
                placeholder="e.g. 24990"
                required
                className="w-full h-10 px-3 text-sm font-mono tabular-nums text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15"
              />
            </div>

            <div className="md:col-span-2">
              <label htmlFor="preview-target-price" className="block text-xs font-medium text-slate-700 mb-1.5">
                Target Alert Price
              </label>
              <input
                id="preview-target-price"
                type="number"
                step="0.01"
                min="0.01"
                value={targetPrice}
                onChange={(e) => setTargetPrice(e.target.value)}
                placeholder="Optional"
                className="w-full h-10 px-3 text-sm font-mono tabular-nums text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15"
              />
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pt-1">
            <div className="space-y-1.5 w-full sm:w-auto">
              <label htmlFor="preview-interval" className="block text-xs font-medium text-slate-700">
                Check Interval (minimum 1 hour)
              </label>
              <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2">
                <div className="grid grid-cols-3 sm:inline-flex items-center p-1 bg-slate-100 rounded-lg gap-1 w-full sm:w-auto">
                  {INTERVAL_PRESETS.map((hrs) => (
                    <button
                      key={hrs}
                      type="button"
                      onClick={() => setIntervalHours(String(hrs))}
                      className={`px-2.5 py-1 text-xs font-mono tabular-nums rounded-md transition-colors text-center whitespace-nowrap cursor-pointer ${
                        Number(intervalHours) === hrs
                          ? 'bg-white text-slate-900 shadow-xs font-medium'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {hrs}h
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    id="preview-interval"
                    type="number"
                    step="any"
                    value={intervalHours}
                    onChange={(e) => {
                      setIntervalHours(e.target.value);
                      if (errorMsg) setErrorMsg(null);
                    }}
                    aria-label="Custom check interval in hours"
                    className="w-20 h-9 px-2.5 text-sm font-mono tabular-nums text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600"
                  />
                  <span className="text-xs text-slate-500">hours</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 w-full sm:w-auto">
              {Number(currentPrice) > 0 && Number(targetPrice) > 0 && Number(targetPrice) < Number(currentPrice) && (
                <span className="text-xs text-slate-500 font-mono tabular-nums hidden md:inline">
                  Alert below {formatCurrency(Number(targetPrice), currency)}
                </span>
              )}
              <button
                type="submit"
                disabled={submitting}
                className="w-full sm:w-auto h-10 px-5 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {submitting ? 'Saving...' : 'Start Tracking'}
              </button>
            </div>
          </div>
        </form>
      )}
    </section>
  );
}
