import crypto from 'node:crypto';
import { formatCurrency, isValidEmail, isValidTelegramChatId } from '../src/lib/priceUtils';
import { resolveVapidConfig, sendWebPushMessage } from '../src/lib/webPush';
import { trackerStore } from './store';
import type {
  AlertLogEntry,
  AlertSettings,
  ChannelDeliveryResult,
  CurrencyCode,
  ServerCapabilities,
  SseAlertEvent,
} from '../src/types/tracker';
import type { Response } from 'express';

const sseClients = new Set<Response>();

export function registerSseClient(res: Response): void {
  sseClients.add(res);
  res.on('close', () => {
    sseClients.delete(res);
  });
}

function broadcastSse(event: SseAlertEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

export function getServerCapabilities(): ServerCapabilities {
  const vapid = resolveVapidConfig(process.env);
  return {
    emailConfigured: Boolean(
      process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.trim().length > 0
    ),
    telegramBotConfigured: Boolean(
      process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN.trim().length > 0
    ),
    pushConfigured: Boolean(vapid),
    vapidPublicKey: vapid ? vapid.publicKey : null,
    pushSubscriptionCount: trackerStore.getPushSubscriptions().length,
  };
}

async function sendEmailChannel(
  settings: AlertSettings,
  subject: string,
  plainText: string
): Promise<ChannelDeliveryResult> {
  if (!settings.email.enabled) {
    return {
      channel: 'email',
      status: 'disabled',
      destination: settings.email.address || 'Not set',
      detail: 'Email alerts are turned off.',
    };
  }

  if (!isValidEmail(settings.email.address)) {
    return {
      channel: 'email',
      status: 'failed',
      destination: settings.email.address || 'Not set',
      detail: 'Enter a valid recipient email address in Alert Setup.',
    };
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return {
      channel: 'email',
      status: 'logged',
      destination: settings.email.address.trim(),
      detail: 'Alert recorded locally. Set RESEND_API_KEY in server secrets to deliver real emails.',
    };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM?.trim() || 'PricePulse <onboarding@resend.dev>',
        to: [settings.email.address.trim()],
        subject,
        text: plainText,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        channel: 'email',
        status: 'failed',
        destination: settings.email.address.trim(),
        detail: `Email API rejected request (${res.status}): ${body.slice(0, 120)}`,
      };
    }

    return {
      channel: 'email',
      status: 'sent',
      destination: settings.email.address.trim(),
      detail: 'Email delivered instantly via Resend API.',
    };
  } catch (err) {
    return {
      channel: 'email',
      status: 'failed',
      destination: settings.email.address.trim(),
      detail: err instanceof Error ? `Email delivery failed: ${err.message}` : 'Email delivery failed.',
    };
  }
}

async function sendTelegramChannel(
  settings: AlertSettings,
  messageText: string
): Promise<ChannelDeliveryResult> {
  if (!settings.telegram.enabled) {
    return {
      channel: 'telegram',
      status: 'disabled',
      destination: settings.telegram.chatId || 'Not set',
      detail: 'Telegram alerts are turned off.',
    };
  }

  if (!isValidTelegramChatId(settings.telegram.chatId)) {
    return {
      channel: 'telegram',
      status: 'failed',
      destination: settings.telegram.chatId || 'Not set',
      detail: 'Enter a numeric Telegram Chat ID (from @userinfobot) in Alert Setup.',
    };
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    return {
      channel: 'telegram',
      status: 'logged',
      destination: `Chat ${settings.telegram.chatId.trim()}`,
      detail: 'Alert recorded locally. Set TELEGRAM_BOT_TOKEN in server secrets to deliver live Telegram messages.',
    };
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: settings.telegram.chatId.trim(),
        text: messageText,
        disable_web_page_preview: false,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      return {
        channel: 'telegram',
        status: 'failed',
        destination: `Chat ${settings.telegram.chatId.trim()}`,
        detail: `Telegram API rejected request (${response.status}): ${errBody.slice(0, 120)}`,
      };
    }

    return {
      channel: 'telegram',
      status: 'sent',
      destination: `Chat ${settings.telegram.chatId.trim()}`,
      detail: 'Delivered instantly via Telegram Bot API.',
    };
  } catch (err) {
    return {
      channel: 'telegram',
      status: 'failed',
      destination: `Chat ${settings.telegram.chatId.trim()}`,
      detail: err instanceof Error ? `Telegram error: ${err.message}` : 'Telegram request failed.',
    };
  }
}

async function sendPushChannel(
  settings: AlertSettings,
  alertId: string,
  title: string,
  body: string,
  url: string | null
): Promise<ChannelDeliveryResult> {
  if (!settings.push.enabled) {
    return {
      channel: 'push',
      status: 'disabled',
      destination: 'Browser Push',
      detail: 'Browser push alerts are turned off.',
    };
  }

  const vapid = resolveVapidConfig(process.env);
  const subscriptions = trackerStore.getPushSubscriptions();

  if (vapid && subscriptions.length > 0) {
    const results = await Promise.all(
      subscriptions.map(async (sub) => {
        const outcome = await sendWebPushMessage(
          sub,
          { title, body, url: url || '/', tag: `pricepulse-${alertId}`, alertId },
          vapid
        );
        if (outcome.gone) {
          trackerStore.deletePushSubscription(sub.endpoint);
        }
        return outcome;
      })
    );
    const delivered = results.filter((r) => r.ok).length;
    if (delivered > 0) {
      const label = delivered === 1 ? '1 subscribed browser' : `${delivered} subscribed browsers`;
      return {
        channel: 'push',
        status: 'sent',
        destination: label,
        detail: `Delivered background Web Push notification to ${label}.`,
      };
    }
    const firstErr = results.find((r) => !r.ok)?.error;
    return {
      channel: 'push',
      status: 'failed',
      destination: `${subscriptions.length} subscribed browser(s)`,
      detail: firstErr || 'Web Push delivery failed for all registered browsers.',
    };
  }

  if (vapid && subscriptions.length === 0) {
    return {
      channel: 'push',
      status: 'failed',
      destination: '0 subscribed browsers',
      detail:
        'No browser push subscription is registered yet. Open Alert Setup in Chrome and enable Browser Push.',
    };
  }

  return {
    channel: 'push',
    status: 'logged',
    destination: `${sseClients.size || 1} active browser session`,
    detail:
      'Delivered to open browser session. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY for background Web Push.',
  };
}

export interface DispatchAlertParams {
  type: 'price_drop' | 'test';
  productId: string | null;
  productTitle: string;
  productUrl: string | null;
  platformLabel: string;
  currency: CurrencyCode;
  previousPrice: number | null;
  newPrice: number | null;
  dropAmount: number | null;
  dropPercent: number | null;
  customMessage?: string;
  onlyChannel?: 'email' | 'telegram' | 'push';
}

export async function dispatchMultiChannelAlert(
  settings: AlertSettings,
  params: DispatchAlertParams
): Promise<AlertLogEntry> {
  const alertId = `alert-${crypto.randomUUID().slice(0, 8)}`;
  const isDrop = params.type === 'price_drop' && params.previousPrice !== null && params.newPrice !== null;
  const subject = isDrop
    ? `Price Drop (${params.dropPercent}%): ${params.productTitle}`
    : `PricePulse Test Alert — Notification Check`;
  const pushTitle = isDrop
    ? `Price Drop (${params.dropPercent}%): ${params.productTitle}`
    : `PricePulse Test Alert`;

  const message =
    params.customMessage ||
    (isDrop
      ? `Price dropped by ${params.dropPercent}% (${formatCurrency(params.previousPrice!, params.currency)} → ${formatCurrency(params.newPrice!, params.currency)}) on ${params.platformLabel}.`
      : `Test alert triggered from PricePulse Alert Setup.`);

  const fullText = [
    subject,
    '',
    message,
    params.productUrl ? `Product Link: ${params.productUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const deliveries: ChannelDeliveryResult[] = [];

  if (!params.onlyChannel || params.onlyChannel === 'email') {
    deliveries.push(await sendEmailChannel(settings, subject, fullText));
  }
  if (!params.onlyChannel || params.onlyChannel === 'telegram') {
    deliveries.push(await sendTelegramChannel(settings, fullText));
  }
  if (!params.onlyChannel || params.onlyChannel === 'push') {
    deliveries.push(await sendPushChannel(settings, alertId, pushTitle, message, params.productUrl));
  }

  const entry: AlertLogEntry = {
    id: alertId,
    type: params.type,
    productId: params.productId,
    productTitle: params.productTitle,
    productUrl: params.productUrl,
    platformLabel: params.platformLabel,
    currency: params.currency,
    previousPrice: params.previousPrice,
    newPrice: params.newPrice,
    dropAmount: params.dropAmount,
    dropPercent: params.dropPercent,
    triggeredAt: new Date().toISOString(),
    message,
    deliveries,
  };

  if (settings.push.enabled && (!params.onlyChannel || params.onlyChannel === 'push')) {
    broadcastSse({ type: 'alert', alert: entry });
  }

  return entry;
}
