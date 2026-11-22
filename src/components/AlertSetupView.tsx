import { useEffect, useState, type FormEvent } from 'react';
import { Bell, Mail, Send } from 'lucide-react';
import { showBrowserPushNotification } from '../api/client';
import { isValidEmail, isValidTelegramChatId } from '../lib/priceUtils';
import type { AlertSettings, ServerCapabilities, TriggerMode } from '../types/tracker';

interface AlertSetupViewProps {
  settings: AlertSettings;
  capabilities: ServerCapabilities;
  onSaveSettings: (next: AlertSettings) => Promise<void>;
  onSendTest: (channel?: 'email' | 'telegram' | 'push') => Promise<void>;
}

export function AlertSetupView({
  settings,
  capabilities,
  onSaveSettings,
  onSendTest,
}: AlertSetupViewProps) {
  const [triggerMode, setTriggerMode] = useState<TriggerMode>(settings.triggerMode);
  const [minDropPercent, setMinDropPercent] = useState(String(settings.minDropPercent));
  const [emailEnabled, setEmailEnabled] = useState(settings.email.enabled);
  const [emailAddress, setEmailAddress] = useState(settings.email.address);
  const [telegramEnabled, setTelegramEnabled] = useState(settings.telegram.enabled);
  const [telegramChatId, setTelegramChatId] = useState(settings.telegram.chatId);
  const [pushEnabled, setPushEnabled] = useState(settings.push.enabled);

  const [browserPermission, setBrowserPermission] = useState<NotificationPermission | 'unsupported'>(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
    return Notification.permission;
  });

  const [saving, setSaving] = useState(false);
  const [testingChannel, setTestingChannel] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    setTriggerMode(settings.triggerMode);
    setMinDropPercent(String(settings.minDropPercent));
    setEmailEnabled(settings.email.enabled);
    setEmailAddress(settings.email.address);
    setTelegramEnabled(settings.telegram.enabled);
    setTelegramChatId(settings.telegram.chatId);
    setPushEnabled(settings.push.enabled);
  }, [settings]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setFeedback(null);

    if (emailEnabled && !isValidEmail(emailAddress)) {
      setFeedback({ type: 'err', text: 'Enter a valid email address to receive Email alerts.' });
      return;
    }

    if (telegramChatId.trim() && !isValidTelegramChatId(telegramChatId)) {
      setFeedback({
        type: 'err',
        text: 'Telegram Chat ID should be a numeric ID (5 to 20 digits, e.g. 123456789).',
      });
      return;
    }

    const parsedPct = Number(minDropPercent);
    if (!Number.isFinite(parsedPct) || parsedPct < 1 || parsedPct > 95) {
      setFeedback({ type: 'err', text: 'Minimum drop percentage must be between 1% and 95%.' });
      return;
    }

    setSaving(true);
    try {
      await onSaveSettings({
        ...settings,
        triggerMode,
        minDropPercent: Math.round(parsedPct),
        email: {
          enabled: emailEnabled,
          address: emailAddress.trim(),
        },
        telegram: {
          enabled: telegramEnabled,
          chatId: telegramChatId.trim(),
        },
        push: {
          enabled: pushEnabled,
        },
      });
      setFeedback({ type: 'ok', text: 'Alert channel settings saved.' });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Failed to save alert settings.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleRequestPushPermission() {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setBrowserPermission('unsupported');
      return;
    }
    try {
      const result = await Notification.requestPermission();
      setBrowserPermission(result);
      if (result === 'granted') {
        setPushEnabled(true);
        await showBrowserPushNotification(
          'PricePulse Browser Push Enabled',
          'You will receive instant alerts here whenever a tracked product drops in price.'
        );
      }
    } catch {
      setFeedback({
        type: 'err',
        text: 'Browser permission prompt was blocked in this window.',
      });
    }
  }

  async function handleTest(channel?: 'email' | 'telegram' | 'push') {
    setFeedback(null);
    setTestingChannel(channel || 'all');
    try {
      await onSendTest(channel);
      if (!channel || channel === 'push') {
        await showBrowserPushNotification(
          'PricePulse Test Alert',
          'Instant browser push notifications are active.'
        );
      }
      setFeedback({
        type: 'ok',
        text: channel
          ? `Test ${channel} alert dispatched — check Drop Alerts for the delivery log.`
          : 'Test notification dispatched across enabled channels.',
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Failed to dispatch test alert.',
      });
    } finally {
      setTestingChannel(null);
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-slate-900">
            Instant Alert Setup
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Configure Email, Telegram, and Browser Push alerts triggered immediately when a price drops.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 w-full sm:w-auto shrink-0">
          <button
            type="button"
            onClick={() => handleTest(undefined)}
            disabled={testingChannel !== null}
            className="flex-1 sm:flex-initial h-9 px-3.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            {testingChannel === 'all' ? 'Sending...' : 'Test All Channels'}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="flex-1 sm:flex-initial h-9 px-4 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            {saving ? 'Saving...' : 'Save Alert Settings'}
          </button>
        </div>
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

      {/* Trigger Rules */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 md:p-6 space-y-4">
        <div>
          <h3 className="font-display text-base font-semibold text-slate-900">
            When Should Alerts Fire?
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Choose whether every price drop sends an instant alert or only drops meeting a threshold.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {(
            [
              {
                id: 'any_drop',
                title: 'Any Price Drop',
                desc: 'Notify immediately whenever a product price goes lower than the previous check.',
              },
              {
                id: 'percent_drop',
                title: 'Percentage Drop',
                desc: 'Notify when price drops by at least your minimum percentage or hits target.',
              },
              {
                id: 'target_price',
                title: 'Target Price Only',
                desc: 'Notify only when a product drops to or below its configured target price.',
              },
            ] as const
          ).map((opt) => {
            const active = triggerMode === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setTriggerMode(opt.id)}
                className={`text-left p-4 rounded-lg border transition-colors cursor-pointer ${
                  active
                    ? 'border-blue-600 bg-blue-50/40'
                    : 'border-slate-200 hover:border-slate-300 bg-white'
                }`}
              >
                <p className="text-sm font-semibold text-slate-900">{opt.title}</p>
                <p className="text-xs text-slate-500 mt-1 leading-relaxed">{opt.desc}</p>
              </button>
            );
          })}
        </div>

        {triggerMode === 'percent_drop' && (
          <div className="pt-2 flex flex-wrap items-center gap-3">
            <label htmlFor="min-drop-pct" className="text-xs font-medium text-slate-700">
              Minimum Drop Threshold (%)
            </label>
            <input
              id="min-drop-pct"
              type="number"
              min="1"
              max="95"
              value={minDropPercent}
              onChange={(e) => setMinDropPercent(e.target.value)}
              className="w-20 h-9 px-3 text-sm font-mono tabular-nums text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600"
            />
          </div>
        )}
      </section>

      {/* Three Notification Channels */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 1. Email Channel */}
        <section className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-5">
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Mail className="w-5 h-5 text-slate-700 shrink-0" />
                <h3 className="font-display text-base font-semibold text-slate-900">
                  Email Alerts
                </h3>
              </div>
              <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={emailEnabled}
                  onChange={(e) => setEmailEnabled(e.target.checked)}
                  className="w-4 h-4 accent-blue-700 rounded"
                />
                Enabled
              </label>
            </div>

            <div>
              <label htmlFor="email-recipient" className="block text-xs font-medium text-slate-700 mb-1.5">
                Recipient Email Address
              </label>
              <input
                id="email-recipient"
                type="email"
                value={emailAddress}
                onChange={(e) => setEmailAddress(e.target.value)}
                placeholder="you@example.com"
                className="w-full h-10 px-3 text-sm text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600"
              />
            </div>

            <div className="text-xs text-slate-500 space-y-1 break-words">
              <p>
                Email delivery status:{' '}
                <span
                  className={`font-medium ${
                    capabilities.emailConfigured ? 'text-emerald-700' : 'text-amber-700'
                  }`}
                >
                  {capabilities.emailConfigured ? 'Connected' : 'Log-only until email secret is set'}
                </span>
              </p>
              {!capabilities.emailConfigured && (
                <p className="leading-relaxed">
                  Add <span className="font-mono text-slate-700">RESEND_API_KEY</span> in secrets for live inbox delivery.
                </p>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={() => handleTest('email')}
            disabled={testingChannel !== null}
            className="w-full h-9 px-3 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-lg transition-colors cursor-pointer"
          >
            {testingChannel === 'email' ? 'Sending Test Email...' : 'Send Test Email'}
          </button>
        </section>

        {/* 2. Telegram Channel */}
        <section className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-5">
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Send className="w-5 h-5 text-slate-700 shrink-0" />
                <h3 className="font-display text-base font-semibold text-slate-900">
                  Telegram Alerts
                </h3>
              </div>
              <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={telegramEnabled}
                  onChange={(e) => setTelegramEnabled(e.target.checked)}
                  className="w-4 h-4 accent-blue-700 rounded"
                />
                Enabled
              </label>
            </div>

            <div>
              <label htmlFor="telegram-chat-id" className="block text-xs font-medium text-slate-700 mb-1.5">
                Your Telegram Chat ID
              </label>
              <input
                id="telegram-chat-id"
                type="text"
                inputMode="numeric"
                value={telegramChatId}
                onChange={(e) => setTelegramChatId(e.target.value)}
                placeholder="e.g. 123456789"
                className="w-full h-10 px-3 text-sm font-mono tabular-nums text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600"
              />
            </div>

            <div className="text-xs text-slate-500 space-y-1.5">
              <p>
                Bot connection:{' '}
                <span
                  className={`font-medium ${
                    capabilities.telegramBotConfigured ? 'text-emerald-700' : 'text-amber-700'
                  }`}
                >
                  {capabilities.telegramBotConfigured
                    ? 'Bot token configured'
                    : 'Set TELEGRAM_BOT_TOKEN in secrets'}
                </span>
              </p>
              <ol className="list-decimal list-inside space-y-0.5 text-slate-500 leading-relaxed">
                <li>Message <span className="font-mono text-slate-700">@userinfobot</span> on Telegram to get your numeric Chat ID.</li>
                <li>Start your bot created via <span className="font-mono text-slate-700">@BotFather</span> and add its token to server secrets.</li>
              </ol>
            </div>
          </div>

          <button
            type="button"
            onClick={() => handleTest('telegram')}
            disabled={testingChannel !== null}
            className="w-full h-9 px-3 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-lg transition-colors cursor-pointer"
          >
            {testingChannel === 'telegram' ? 'Sending Test Telegram...' : 'Send Test Telegram'}
          </button>
        </section>

        {/* 3. Browser Push Channel */}
        <section className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-5">
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Bell className="w-5 h-5 text-slate-700 shrink-0" />
                <h3 className="font-display text-base font-semibold text-slate-900">
                  Browser Push Alerts
                </h3>
              </div>
              <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={pushEnabled}
                  onChange={(e) => setPushEnabled(e.target.checked)}
                  className="w-4 h-4 accent-blue-700 rounded"
                />
                Enabled
              </label>
            </div>

            <div className="text-xs text-slate-600 space-y-2">
              <p>
                Permission status:{' '}
                <span
                  className={`font-medium capitalize ${
                    browserPermission === 'granted'
                      ? 'text-emerald-700'
                      : browserPermission === 'denied'
                        ? 'text-red-700'
                        : 'text-slate-700'
                  }`}
                >
                  {browserPermission}
                </span>
              </p>
              <p className="text-slate-500 leading-relaxed">
                Uses the browser Notifications API and live event stream to surface instant desktop and mobile push alerts on every price drop.
              </p>
            </div>

            {browserPermission === 'default' && (
              <button
                type="button"
                onClick={handleRequestPushPermission}
                className="w-full h-9 px-3 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors cursor-pointer"
              >
                Enable Browser Push Permission
              </button>
            )}
            {browserPermission === 'denied' && (
              <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 leading-relaxed">
                Native OS notifications are blocked in your browser site settings. Allow notifications for this site to receive OS popups; live in-app push alerts remain active.
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={() => handleTest('push')}
            disabled={testingChannel !== null}
            className="w-full h-9 px-3 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-lg transition-colors cursor-pointer"
          >
            {testingChannel === 'push' ? 'Sending Test Push...' : 'Send Test Push Alert'}
          </button>
        </section>
      </div>
    </form>
  );
}
