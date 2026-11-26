// PricePulse Service Worker for Background Web Push Notifications

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {
    title: 'PricePulse Price Drop',
    body: 'A tracked product dropped in price.',
    url: '/',
    tag: 'pricepulse-drop-alert',
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      if (parsed && typeof parsed === 'object') {
        payload = {
          title:
            typeof parsed.title === 'string' && parsed.title.trim()
              ? parsed.title.trim()
              : payload.title,
          body:
            typeof parsed.body === 'string' && parsed.body.trim()
              ? parsed.body.trim()
              : payload.body,
          url:
            typeof parsed.url === 'string' && parsed.url.trim()
              ? parsed.url.trim()
              : payload.url,
          tag:
            typeof parsed.tag === 'string' && parsed.tag.trim()
              ? parsed.tag.trim()
              : payload.tag,
        };
      }
    } catch {
      try {
        const text = event.data.text();
        if (text && text.trim()) {
          payload.body = text.trim();
        }
      } catch {
        // Keep default fallback payload
      }
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/favicon.svg',
      tag: payload.tag,
      data: { url: payload.url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = (event.notification.data && event.notification.data.url) || '/';
  let isExternal = false;
  try {
    const parsed = new URL(rawUrl, self.location.origin);
    isExternal =
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.origin !== self.location.origin;
  } catch {
    isExternal = false;
  }

  event.waitUntil(
    (async () => {
      if (isExternal && self.clients.openWindow) {
        return self.clients.openWindow(rawUrl);
      }
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('/');
      }
    })()
  );
});
