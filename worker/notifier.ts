import { formatCurrency, isValidEmail, isValidTelegramChatId } from '../src/lib/priceUtils';
import { resolveVapidConfig, sendWebPushMessage } from '../src/lib/webPush';
import type {
  AlertLogEntry,
  AlertSettings,
  ChannelDeliveryResult,
  CurrencyCode,
  ServerCapabilities,
} from '../src/types/tracker';
import { deletePushSubscriptionD1, getPushSubscriptionsD1 } from './db';
import type { WorkerEnv } from './types';

export function getWorkerCapabilities(
  env: WorkerEnv,
  pushSubscriptionCount: number = 0
): ServerCapabilities {
  const vapid = resolveVapidConfig(env);
  return {
    emailConfigured: Boolean(env.RESEND_API_KEY && env.RESEND_API_KEY.trim().length > 0),
    telegramBotConfigured: Boolean(
      env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_TOKEN.trim().length > 0
    ),
    pushConfigured: Boolean(vapid),
    vapidPublicKey: vapid ? vapid.publicKey : null,
    pushSubscriptionCount,
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

async function sendWebPushEdge(
  env: WorkerEnv,
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

  const vapid = resolveVapidConfig(env);
  if (!vapid) {
    return {
      channel: 'push',
      status: 'logged',
      destination: 'Browser Push',
      detail:
        'Alert recorded in D1. Configure VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY secrets to deliver background Web Push alerts.',
    };
  }

  const subscriptions = await getPushSubscriptionsD1(env.DB);
  if (subscriptions.length === 0) {
    return {
      channel: 'push',
      status: 'failed',
      destination: '0 subscribed browsers',
      detail:
        'No browser push subscription is registered yet. Open Alert Setup in Chrome and enable Browser Push to receive background alerts.',
    };
  }

  const results = await Promise.all(
    subscriptions.map(async (sub) => {
      const outcome = await sendWebPushMessage(
        sub,
        {
          title,
          body,
          url: url || '/',
          tag: `pricepulse-${alertId}`,
          alertId,
        },
        vapid
      );
      if (outcome.gone) {
        await deletePushSubscriptionD1(env.DB, sub.endpoint).catch(() => undefined);
      }
      return outcome;
    })
  );

  const delivered = results.filter((r) => r.ok).length;
  const expired = results.filter((r) => r.gone).length;
  const failed = results.filter((r) => !r.ok && !r.gone);

  if (delivered > 0) {
    const label = delivered === 1 ? '1 subscribed browser' : `${delivered} subscribed browsers`;
    const suffix =
      expired > 0 || failed.length > 0
        ? ` (${expired > 0 ? `${expired} expired removed` : ''}${expired > 0 && failed.length > 0 ? ', ' : ''}${failed.length > 0 ? `${failed.length} failed` : ''})`
        : '';
    return {
      channel: 'push',
      status: 'sent',
      destination: label,
      detail: `Delivered background Web Push notification to ${label}.${suffix}`,
    };
  }

  const firstError = failed[0]?.error;
  if (expired === subscriptions.length) {
    return {
      channel: 'push',
      status: 'failed',
      destination: 'Expired browser subscription',
      detail:
        'Browser push subscription expired and was removed. Open Alert Setup in Chrome to re-subscribe.',
    };
  }

  return {
    channel: 'push',
    status: 'failed',
    destination: `${subscriptions.length} subscribed browser(s)`,
    detail: firstError || 'Web Push delivery failed for all registered browsers.',
  };
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
  const alertId = `alert-${crypto.randomUUID().slice(0, 8)}`;
  const isDrop =
    params.type === 'price_drop' && params.previousPrice !== null && params.newPrice !== null;
  const subject = isDrop
    ? `Price Drop (${params.dropPercent}%): ${params.productTitle}`
    : 'PricePulse Test Alert — Notification Check';
  const pushTitle = isDrop
    ? `Price Drop (${params.dropPercent}%): ${params.productTitle}`
    : 'PricePulse Test Alert';
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
      await sendWebPushEdge(env, settings, alertId, pushTitle, message, params.productUrl)
    );
  }

  return {
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
}
