/* Service worker for scenario run (failure/success) Web Push notifications. */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || 'Scenario alert';
  const options = {
    body: data.body || '',
    // App has no bundled icon; browsers fall back to a default when these 404.
    icon: '/vite.svg',
    badge: '/vite.svg',
    tag: data.runId ? `run-${data.runId}` : undefined,
    data: { url: data.url || '/runs' },
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/runs';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          if ('navigate' in client) {
            try { client.navigate(target); } catch { /* cross-origin guard */ }
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    }),
  );
});
