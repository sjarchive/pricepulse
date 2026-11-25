import { useEffect, useState } from 'react';
import { BellRing, X } from 'lucide-react';
import { MOTION_DURATION_MS } from '../lib/motion';
import type { AlertLogEntry } from '../types/tracker';

interface PushToastBannerProps {
  alert: AlertLogEntry | null;
  onDismiss: () => void;
  onViewAlerts: () => void;
}

export function PushToastBanner({ alert, onDismiss, onViewAlerts }: PushToastBannerProps) {
  const [renderedAlert, setRenderedAlert] = useState<AlertLogEntry | null>(alert);
  const [visible, setVisible] = useState(Boolean(alert));

  useEffect(() => {
    if (alert) {
      setRenderedAlert(alert);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }

    setVisible(false);
    const timer = setTimeout(() => {
      setRenderedAlert(null);
    }, MOTION_DURATION_MS.normal);
    return () => clearTimeout(timer);
  }, [alert]);

  if (!renderedAlert) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-visible={visible ? 'true' : 'false'}
      className="fixed bottom-4 left-4 right-4 sm:bottom-5 sm:left-auto sm:right-5 z-50 sm:w-full sm:max-w-md bg-slate-900 text-white rounded-xl shadow-lg border border-slate-800 p-4 pp-toast"
    >
      <div className="flex items-start gap-3">
        <BellRing className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-snug truncate">{renderedAlert.productTitle}</p>
          <p className="text-xs text-slate-300 mt-1 leading-relaxed">{renderedAlert.message}</p>
          <div className="mt-2.5 flex items-center gap-4 text-xs">
            <button
              type="button"
              onClick={onViewAlerts}
              className="font-medium text-blue-300 hover:text-blue-200 underline underline-offset-2 cursor-pointer"
            >
              View delivery log
            </button>
            <span className="text-slate-400">
              {renderedAlert.deliveries
                .filter((d) => d.status !== 'disabled')
                .map((d) => d.channel)
                .join(' · ')}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss alert notification"
          className="p-1 text-slate-400 hover:text-white rounded cursor-pointer shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
