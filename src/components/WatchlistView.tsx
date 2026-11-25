import { useMemo, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  ExternalLink,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import {
  formatCountdown,
  formatCurrency,
  formatRelativeTime,
  getPriceChangePercent,
  sanitizeExternalUrl,
} from '../lib/priceUtils';
import type { TrackedProduct } from '../types/tracker';
import { ProductThumbnail } from './ProductThumbnail';

interface WatchlistViewProps {
  products: TrackedProduct[];
  selectedProductId: string | null;
  checkingId: string | null;
  nowMs: number;
  onSelectProduct: (product: TrackedProduct) => void;
  onCheckNow: (product: TrackedProduct) => void;
  onDeleteProduct: (product: TrackedProduct) => void;
  onFocusTrackInput: () => void;
}

type FilterTab = 'all' | 'drops' | 'amazon' | 'flipkart' | 'myntra' | 'other';

export function WatchlistView({
  products,
  selectedProductId,
  checkingId,
  nowMs,
  onSelectProduct,
  onCheckNow,
  onDeleteProduct,
  onFocusTrackInput,
}: WatchlistViewProps) {
  const [filter, setFilter] = useState<FilterTab>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const metrics = useMemo(() => {
    const totalTracked = products.length;
    const activeDrops = products.filter((p) => p.currentPrice < p.initialPrice).length;
    const targetHits = products.filter(
      (p) => p.targetPrice !== null && p.currentPrice <= p.targetPrice
    ).length;

    const earliestNext = products
      .map((p) => Date.parse(p.nextCheckAt))
      .filter((ms) => !Number.isNaN(ms))
      .sort((a, b) => a - b)[0];

    return {
      totalTracked,
      activeDrops,
      targetHits,
      nextCheckLabel: earliestNext
        ? formatCountdown(new Date(earliestNext).toISOString(), nowMs)
        : 'None scheduled',
    };
  }, [products, nowMs]);

  const filteredProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return products.filter((p) => {
      if (filter === 'drops' && !(p.currentPrice < p.initialPrice)) return false;
      if (filter === 'amazon' && p.platform !== 'amazon') return false;
      if (filter === 'flipkart' && p.platform !== 'flipkart') return false;
      if (filter === 'myntra' && p.platform !== 'myntra') return false;
      if (
        filter === 'other' &&
        (p.platform === 'amazon' || p.platform === 'flipkart' || p.platform === 'myntra')
      ) {
        return false;
      }

      if (q) {
        const hay = `${p.title} ${p.platformLabel} ${p.url}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [products, filter, searchQuery]);

  const filterTabs: Array<{ id: FilterTab; label: string }> = [
    { id: 'all', label: 'All Stores' },
    { id: 'drops', label: 'Price Drops' },
    { id: 'amazon', label: 'Amazon' },
    { id: 'flipkart', label: 'Flipkart' },
    { id: 'myntra', label: 'Myntra' },
    { id: 'other', label: 'Other Stores' },
  ];

  if (products.length === 0) {
    return (
      <section
        aria-label="Empty watchlist"
        className="bg-white border border-slate-200 rounded-xl px-6 py-16 text-center"
      >
        <h3 className="font-display text-lg font-semibold text-slate-900">
          Your watchlist is empty
        </h3>
        <p className="text-sm text-slate-500 mt-1.5 max-w-md mx-auto leading-relaxed">
          Paste any product link above from Amazon, Flipkart, Myntra, or another store to start tracking its price and receive instant drop alerts.
        </p>
        <button
          type="button"
          onClick={onFocusTrackInput}
          className="mt-5 h-10 px-5 text-sm font-medium bg-blue-700 hover:bg-blue-800 text-white rounded-lg transition-colors cursor-pointer"
        >
          Paste First Product Link
        </button>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      {/* Flat 4-column summary bar */}
      <section
        aria-label="Watchlist summary"
        className="bg-white border border-slate-200 rounded-xl grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200"
      >
        <div className="p-3.5 sm:p-5 min-w-0">
          <p className="text-xs font-medium text-slate-500">Tracked Products</p>
          <p className="mt-1.5 font-mono text-xl sm:text-2xl font-semibold tabular-nums text-slate-900 truncate">
            {metrics.totalTracked}
          </p>
        </div>
        <div className="p-3.5 sm:p-5 border-l border-slate-200 lg:border-l-0 min-w-0">
          <p className="text-xs font-medium text-slate-500">Active Price Drops</p>
          <p className="mt-1.5 font-mono text-xl sm:text-2xl font-semibold tabular-nums text-emerald-700 truncate">
            {metrics.activeDrops}
          </p>
        </div>
        <div className="p-3.5 sm:p-5 min-w-0">
          <p className="text-xs font-medium text-slate-500">At or Below Target</p>
          <p className="mt-1.5 font-mono text-xl sm:text-2xl font-semibold tabular-nums text-blue-700 truncate">
            {metrics.targetHits}
          </p>
        </div>
        <div className="p-3.5 sm:p-5 border-l border-slate-200 lg:border-l-0 min-w-0">
          <p className="text-xs font-medium text-slate-500">Next Scheduled Check</p>
          <p className="mt-1.5 font-mono text-lg sm:text-2xl font-semibold tabular-nums text-slate-900 truncate">
            {metrics.nextCheckLabel}
          </p>
        </div>
      </section>

      {/* Watchlist Table Container */}
      <section
        aria-label="Tracked products table"
        className="bg-white border border-slate-200 rounded-xl overflow-hidden"
      >
        <div className="p-4 sm:px-5 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div
            role="tablist"
            aria-label="Filter products by store or price drop"
            className="grid grid-cols-3 gap-1.5 w-full lg:w-auto lg:inline-flex lg:items-center lg:gap-1 lg:p-1 lg:bg-slate-100 lg:rounded-lg"
          >
            {filterTabs.map((tab) => {
              const active = filter === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setFilter(tab.id)}
                  className={`h-8 lg:h-auto px-1.5 sm:px-3 lg:py-1.5 text-xs font-medium rounded-lg lg:rounded-md border lg:border-0 transition-colors inline-flex items-center justify-center whitespace-nowrap truncate cursor-pointer ${
                    active
                      ? 'bg-blue-50 border-blue-600 text-blue-700 font-semibold lg:bg-white lg:text-slate-900 lg:shadow-xs lg:font-medium'
                      : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:text-slate-900 lg:bg-transparent lg:hover:bg-transparent'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="relative w-full lg:w-72 shrink-0">
            <label htmlFor="watchlist-search" className="sr-only">
              Search tracked products
            </label>
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              id="watchlist-search"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search product or store..."
              className="w-full h-9 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-600"
            />
          </div>
        </div>

        {filteredProducts.length === 0 ? (
          <div className="px-6 py-14 text-center pp-feedback-enter">
            <p className="font-display text-base font-semibold text-slate-900">
              No tracked products match your filter
            </p>
            <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
              Clear your search query or switch store filters to view all tracked products.
            </p>
            <button
              type="button"
              onClick={() => {
                setFilter('all');
                setSearchQuery('');
              }}
              className="mt-4 px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
            >
              Reset Filters
            </button>
          </div>
        ) : (
          <>
            {/* Mobile card layout — zero horizontal overflow or cut-off controls */}
            <div className="md:hidden divide-y divide-slate-200">
              {filteredProducts.map((product) => {
                const changePct = getPriceChangePercent(product);
                const isDropped = changePct < 0;
                const isIncreased = changePct > 0;
                const hitTarget =
                  product.targetPrice !== null && product.currentPrice <= product.targetPrice;
                const isSelected = selectedProductId === product.id;
                const isChecking = checkingId === product.id;
                const safeHref = sanitizeExternalUrl(product.url);

                return (
                  <article
                    key={product.id}
                    data-testid="watchlist-card"
                    className={`p-4 space-y-3 transition-colors ${
                      isSelected ? 'bg-blue-50/50' : ''
                    }`}
                  >
                    <button
                      type="button"
                      data-no-press
                      onClick={() => onSelectProduct(product)}
                      aria-label={`Inspect ${product.title}`}
                      className="w-full flex items-center gap-3 text-left group cursor-pointer"
                    >
                      <ProductThumbnail
                        src={product.imageUrl}
                        alt={product.title}
                        platformLabel={product.platformLabel}
                        size="md"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-slate-900 group-hover:text-blue-700 transition-colors line-clamp-2 leading-snug break-words">
                          {product.title}
                        </p>
                        <p className="text-xs text-slate-500 mt-1 flex items-center gap-1.5 flex-wrap">
                          <span className="font-medium text-slate-600">{product.platformLabel}</span>
                          <span aria-hidden="true">·</span>
                          <span>Checked {formatRelativeTime(product.lastCheckedAt, nowMs)}</span>
                          {hitTarget && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-medium text-emerald-700">Target met</span>
                            </>
                          )}
                        </p>
                      </div>
                    </button>

                    <div className="grid grid-cols-2 gap-4 pt-3 border-t border-slate-100">
                      <div className="min-w-0">
                        <p className="text-[11px] font-medium text-slate-500 leading-tight">
                          Current Price
                        </p>
                        <p className="font-mono text-base font-semibold tabular-nums text-slate-900 leading-tight mt-1 selectable-text">
                          {formatCurrency(product.currentPrice, product.currency)}
                        </p>
                        <p className="text-xs font-mono tabular-nums text-slate-500 leading-tight mt-1 selectable-text">
                          Low {formatCurrency(product.lowestPrice, product.currency)}
                        </p>
                      </div>
                      <div className="min-w-0 text-right">
                        <p className="text-[11px] font-medium text-slate-500 leading-tight">
                          Target / Change
                        </p>
                        <p className="font-mono text-base font-medium tabular-nums text-slate-700 leading-tight mt-1 selectable-text">
                          {product.targetPrice !== null
                            ? formatCurrency(product.targetPrice, product.currency)
                            : 'Any drop'}
                        </p>
                        <p className="text-xs leading-tight mt-1">
                          {isDropped ? (
                            <span className="inline-flex items-center justify-end gap-0.5 font-mono font-medium tabular-nums text-emerald-700">
                              <ArrowDownRight className="w-3.5 h-3.5" />
                              Down {Math.abs(changePct)}%
                            </span>
                          ) : isIncreased ? (
                            <span className="inline-flex items-center justify-end gap-0.5 font-mono font-medium tabular-nums text-red-700">
                              <ArrowUpRight className="w-3.5 h-3.5" />
                              Up {changePct}%
                            </span>
                          ) : (
                            <span className="font-mono tabular-nums text-slate-500">
                              Every {product.checkIntervalHours}h
                            </span>
                          )}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2 pt-3 border-t border-slate-100">
                      <button
                        type="button"
                        onClick={() => onSelectProduct(product)}
                        className="h-8 px-3 text-xs font-medium text-slate-700 bg-slate-50 hover:bg-slate-100 hover:text-blue-700 border border-slate-200 rounded-lg transition-colors cursor-pointer"
                      >
                        History &amp; Rules
                      </button>
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onCheckNow(product)}
                          disabled={isChecking}
                          aria-label={`Check current price for ${product.title}`}
                          title="Check price now"
                          className="w-8 h-8 inline-flex items-center justify-center text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${isChecking ? 'animate-spin' : ''}`} />
                        </button>
                        {safeHref && (
                          <a
                            href={safeHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Open ${product.title} on ${product.platformLabel}`}
                            title={`Open on ${product.platformLabel}`}
                            className="w-8 h-8 inline-flex items-center justify-center text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => onDeleteProduct(product)}
                          aria-label={`Delete ${product.title}`}
                          title="Remove from watchlist"
                          className="w-8 h-8 inline-flex items-center justify-center text-slate-500 hover:text-red-700 bg-white hover:bg-red-50 border border-slate-200 hover:border-red-200 rounded-lg transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>

            {/* Desktop table layout */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                    <th className="py-3 pl-5 pr-4">Product</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Current Price</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Target</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Since Added</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap hidden xl:table-cell">Cadence</th>
                    <th className="py-3 pl-4 pr-5 text-right whitespace-nowrap">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-sm">
                  {filteredProducts.map((product) => {
                    const changePct = getPriceChangePercent(product);
                    const isDropped = changePct < 0;
                    const isIncreased = changePct > 0;
                    const hitTarget =
                      product.targetPrice !== null && product.currentPrice <= product.targetPrice;
                    const isSelected = selectedProductId === product.id;
                    const isChecking = checkingId === product.id;
                    const safeHref = sanitizeExternalUrl(product.url);

                    return (
                      <tr
                        key={product.id}
                        data-testid="watchlist-row"
                        className={`transition-colors ${
                          isSelected ? 'bg-blue-50/50' : 'hover:bg-slate-50/80'
                        }`}
                      >
                        <td className="py-3.5 pl-5 pr-4 min-w-[260px] max-w-[440px]">
                          <button
                            type="button"
                            data-no-press
                            onClick={() => onSelectProduct(product)}
                            aria-label={`Inspect ${product.title}`}
                            className="w-full flex items-center gap-3.5 text-left group cursor-pointer"
                          >
                            <ProductThumbnail
                              src={product.imageUrl}
                              alt={product.title}
                              platformLabel={product.platformLabel}
                              size="md"
                            />
                            <div className="min-w-0">
                              <p className="font-medium text-slate-900 group-hover:text-blue-700 transition-colors line-clamp-1">
                                {product.title}
                              </p>
                              <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
                                <span className="font-medium text-slate-600">{product.platformLabel}</span>
                                <span aria-hidden="true">·</span>
                                <span>Checked {formatRelativeTime(product.lastCheckedAt, nowMs)}</span>
                                {hitTarget && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span className="font-medium text-emerald-700">Target met</span>
                                  </>
                                )}
                              </p>
                            </div>
                          </button>
                        </td>

                        <td className="py-3.5 px-4 text-right whitespace-nowrap">
                          <p className="font-mono font-semibold tabular-nums text-slate-900 selectable-text">
                            {formatCurrency(product.currentPrice, product.currency)}
                          </p>
                          <p className="text-xs font-mono tabular-nums text-slate-500 mt-0.5 selectable-text">
                            Low {formatCurrency(product.lowestPrice, product.currency)}
                          </p>
                        </td>

                        <td className="py-3.5 px-4 text-right whitespace-nowrap">
                          <span className="font-mono tabular-nums text-slate-700 selectable-text">
                            {product.targetPrice !== null
                              ? formatCurrency(product.targetPrice, product.currency)
                              : 'Any drop'}
                          </span>
                        </td>

                        <td className="py-3.5 px-4 text-right whitespace-nowrap">
                          {isDropped ? (
                            <span className="inline-flex items-center justify-end gap-1 font-mono text-xs font-medium tabular-nums text-emerald-700">
                              <ArrowDownRight className="w-3.5 h-3.5" />
                              Down {Math.abs(changePct)}%
                            </span>
                          ) : isIncreased ? (
                            <span className="inline-flex items-center justify-end gap-1 font-mono text-xs font-medium tabular-nums text-red-700">
                              <ArrowUpRight className="w-3.5 h-3.5" />
                              Up {changePct}%
                            </span>
                          ) : (
                            <span className="font-mono text-xs tabular-nums text-slate-500">
                              Unchanged
                            </span>
                          )}
                        </td>

                        <td className="py-3.5 px-4 text-right whitespace-nowrap hidden xl:table-cell">
                          <p className="font-mono text-xs tabular-nums text-slate-700">
                            Every {product.checkIntervalHours}h
                          </p>
                          <p className="text-xs text-slate-500 mt-0.5">
                            {formatCountdown(product.nextCheckAt, nowMs)}
                          </p>
                        </td>

                        <td className="py-3.5 pl-4 pr-5 text-right whitespace-nowrap">
                          <div className="inline-flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => onSelectProduct(product)}
                              className="px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:text-blue-700 hover:bg-slate-100 rounded-md transition-colors cursor-pointer"
                            >
                              History
                            </button>
                            <button
                              type="button"
                              onClick={() => onCheckNow(product)}
                              disabled={isChecking}
                              aria-label={`Check current price for ${product.title}`}
                              title="Check price now"
                              className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors disabled:opacity-50 cursor-pointer"
                            >
                              <RefreshCw className={`w-4 h-4 ${isChecking ? 'animate-spin' : ''}`} />
                            </button>
                            {safeHref && (
                              <a
                                href={safeHref}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-label={`Open ${product.title} on ${product.platformLabel}`}
                                title={`Open on ${product.platformLabel}`}
                                className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors"
                              >
                                <ExternalLink className="w-4 h-4" />
                              </a>
                            )}
                            <button
                              type="button"
                              onClick={() => onDeleteProduct(product)}
                              aria-label={`Delete ${product.title}`}
                              title="Remove from watchlist"
                              className="p-2 text-slate-400 hover:text-red-700 hover:bg-red-50 rounded-md transition-colors cursor-pointer"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
