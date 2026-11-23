// PricePulse Service Worker for Browser Push Notifications
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
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
