import { useEffect } from 'react';
import { Bell, Clock, ListFilter, LogOut, Sliders, X } from 'lucide-react';
import type { AlertSettings } from '../types/tracker';

export type NavSection = 'watchlist' | 'alerts' | 'setup' | 'schedule';

interface SidebarProps {
  activeSection: NavSection;
  onSelectSection: (section: NavSection) => void;
  productCount: number;
  alertCount: number;
  settings: AlertSettings;
  username: string;
  onSignOut: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

export function Sidebar({
  activeSection,
  onSelectSection,
  productCount,
  alertCount,
  settings,
  username,
  onSignOut,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const navItems: Array<{
    id: NavSection;
    label: string;
    icon: typeof ListFilter;
    meta?: string;
  }> = [
    { id: 'watchlist', label: 'Watchlist', icon: ListFilter, meta: productCount > 0 ? String(productCount) : undefined },
    { id: 'alerts', label: 'Drop Alerts', icon: Bell, meta: alertCount > 0 ? String(alertCount) : undefined },
    { id: 'setup', label: 'Alert Setup', icon: Sliders },
    { id: 'schedule', label: 'Check Schedule', icon: Clock, meta: `${settings.defaultCheckIntervalHours}h` },
  ];

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseMobile();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen, onCloseMobile]);

  const activeChannels = [
    settings.email.enabled ? 'Email' : null,
    settings.telegram.enabled ? 'Telegram' : null,
    settings.push.enabled ? 'Push' : null,
  ].filter(Boolean);

  const content = (
    <div className="flex flex-col h-full bg-white border-r border-slate-200">
      <div className="h-16 px-6 flex items-center justify-between border-b border-slate-200 shrink-0">
        <a
          href="#watchlist"
          onClick={(e) => {
            e.preventDefault();
            onSelectSection('watchlist');
            onCloseMobile();
          }}
          className="inline-flex items-center gap-2.5 font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
        >
          <img
            src="/favicon.svg"
            alt=""
            aria-hidden="true"
            className="w-7 h-7 rounded-lg shrink-0"
          />
          <span>PricePulse</span>
        </a>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close navigation menu"
          className="lg:hidden p-2 -mr-2 text-slate-500 hover:text-slate-900 rounded-md"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <nav aria-label="Main navigation" className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeSection === item.id;
          return (
            <button
              key={item.id}
              type="button"
              data-no-press
              onClick={() => {
                onSelectSection(item.id);
                onCloseMobile();
              }}
              aria-current={isActive ? 'page' : undefined}
              className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap ${
                isActive
                  ? 'bg-slate-100 text-slate-900'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              <span className="flex items-center gap-2.5 min-w-0">
                <Icon
                  className={`w-4 h-4 shrink-0 transition-colors ${isActive ? 'text-blue-700' : 'text-slate-400'}`}
                />
                <span className="truncate">{item.label}</span>
              </span>
              {item.meta !== undefined && (
                <span className="font-mono text-xs tabular-nums text-slate-500 shrink-0">
                  {item.meta}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="px-6 py-5 border-t border-slate-200 text-xs text-slate-500 space-y-2.5">
        <div>
          <p className="font-medium text-slate-700 mb-0.5">Active Alert Channels</p>
          <p className="text-slate-500 leading-relaxed">
            {activeChannels.length > 0 ? activeChannels.join(' · ') : 'All channels paused'}
          </p>
        </div>
        <div>
          <p className="font-medium text-slate-700 mb-0.5">Default Check Cadence</p>
          <p className="font-mono tabular-nums text-slate-600">
            Every {settings.defaultCheckIntervalHours}{' '}
            {settings.defaultCheckIntervalHours === 1 ? 'hour' : 'hours'}
          </p>
        </div>
        <div className="pt-3 border-t border-slate-200 flex items-center justify-between gap-2">
          <span className="font-mono text-slate-700 truncate" title={username}>
            {username}
          </span>
          <button
            type="button"
            onClick={() => {
              onCloseMobile();
              onSignOut();
            }}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-red-700 hover:bg-red-50 rounded-md transition-colors cursor-pointer shrink-0"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign Out
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block w-64 shrink-0 h-screen sticky top-0">{content}</aside>

      <div
        className={`fixed inset-0 z-50 lg:hidden flex ${
          mobileOpen ? 'pointer-events-auto' : 'pointer-events-none'
        }`}
        aria-hidden={!mobileOpen}
        inert={!mobileOpen}
      >
        <div
          data-open={mobileOpen ? 'true' : 'false'}
          className="fixed inset-0 bg-slate-900/40 backdrop-blur-[1px] pp-drawer-backdrop"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
        <aside
          data-open={mobileOpen ? 'true' : 'false'}
          className="relative w-72 max-w-[85vw] h-full z-10 shadow-xl pp-drawer-panel"
        >
          {content}
        </aside>
      </div>
    </>
  );
}
