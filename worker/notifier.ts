import { formatCurrency, isValidEmail, isValidTelegramChatId } from '../src/lib/priceUtils';
import type {
  AlertLogEntry,
  AlertSettings,
  ChannelDeliveryResult,
  CurrencyCode,
  ServerCapabilities,
} from '../src/types/tracker';
import type { WorkerEnv } from './types';

export function getWorkerCapabilities(env: WorkerEnv): ServerCapabilities {
  return {
    emailConfigured: Boolean(env.RESEND_API_KEY && env.RESEND_API_KEY.trim().length > 0),
    telegramBotConfigured: Boolean(
      env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_TOKEN.trim().length > 0
    ),
  };
}

async function sendEmailEdge(
  env: WorkerEnv,
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

  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return {
      channel: 'email',
      status: 'logged',
      destination: settings.email.address.trim(),
      detail: 'Alert recorded in D1. Add RESEND_API_KEY secret in Cloudflare Workers to deliver live emails.',
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
        from: env.RESEND_FROM?.trim() || 'PricePulse <onboarding@resend.dev>',
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
      detail: err instanceof Error ? `Email error: ${err.message}` : 'Email request failed.',
    };
  }
}

async function sendTelegramEdge(
  env: WorkerEnv,
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

  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    return {
      channel: 'telegram',
      status: 'logged',
      destination: `Chat ${settings.telegram.chatId.trim()}`,
      detail: 'Alert recorded in D1. Add TELEGRAM_BOT_TOKEN secret in Cloudflare Workers to deliver live Telegram messages.',
    };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: settings.telegram.chatId.trim(),
        text: messageText,
        disable_web_page_preview: false,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        channel: 'telegram',
        status: 'failed',
        destination: `Chat ${settings.telegram.chatId.trim()}`,
        detail: `Telegram API rejected request (${res.status}): ${body.slice(0, 120)}`,
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

export interface EdgeDispatchParams {
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

export async function dispatchEdgeAlert(
  env: WorkerEnv,
  settings: AlertSettings,
  params: EdgeDispatchParams
): Promise<AlertLogEntry> {
  const isDrop =
    params.type === 'price_drop' && params.previousPrice !== null && params.newPrice !== null;

  const subject = isDrop
    ? `Price Drop (${params.dropPercent}%): ${params.productTitle}`
    : 'PricePulse Test Alert — Notification Check';

  const message =
    params.customMessage ||
    (isDrop
      ? `Price dropped by ${params.dropPercent}% (${formatCurrency(params.previousPrice!, params.currency)} → ${formatCurrency(params.newPrice!, params.currency)}) on ${params.platformLabel}.`
      : 'Test alert triggered from PricePulse Alert Setup.');

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
    deliveries.push(await sendEmailEdge(env, settings, subject, fullText));
  }
  if (!params.onlyChannel || params.onlyChannel === 'telegram') {
    deliveries.push(await sendTelegramEdge(env, settings, fullText));
  }
  if (!params.onlyChannel || params.onlyChannel === 'push') {
    deliveries.push(
      settings.push.enabled
        ? {
            channel: 'push',
            status: 'sent',
            destination: 'Browser Push',
            detail: 'Queued for instant browser notification delivery.',
          }
        : {
            channel: 'push',
            status: 'disabled',
            destination: 'Browser Push',
            detail: 'Browser push alerts are turned off.',
          }
    );
  }

  return {
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
}
