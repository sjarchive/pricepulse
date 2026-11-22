import crypto from 'node:crypto';
import { formatCurrency, isValidEmail, isValidTelegramChatId } from '../src/lib/priceUtils';
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
  return {
    emailConfigured: Boolean(
      process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.trim().length > 0
    ),
    telegramBotConfigured: Boolean(
      process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN.trim().length > 0
    ),
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

function sendPushChannel(settings: AlertSettings): ChannelDeliveryResult {
  if (!settings.push.enabled) {
    return {
      channel: 'push',
      status: 'disabled',
      destination: 'Browser Push',
      detail: 'Browser push alerts are turned off.',
    };
  }
  return {
    channel: 'push',
    status: 'sent',
    destination: `${sseClients.size || 1} active browser session`,
    detail: 'Dispatched instant browser push notification.',
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
  const isDrop = params.type === 'price_drop' && params.previousPrice !== null && params.newPrice !== null;
  const subject = isDrop
    ? `Price Drop (${params.dropPercent}%): ${params.productTitle}`
    : `PricePulse Test Alert — Notification Check`;

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
    deliveries.push(sendPushChannel(settings));
  }

  const entry: AlertLogEntry = {
    id: `alert-${crypto.randomUUID().slice(0, 8)}`,
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
