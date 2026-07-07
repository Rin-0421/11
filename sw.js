// 空殼 Service Worker——目的只是讓 Android Chrome 允許用
// ServiceWorkerRegistration.showNotification() 顯示通知。
// 不做任何快取或攔截，避免影響原本網頁的載入行為。

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// 點擊通知時，嘗試把焦點帶回已開啟的分頁，沒有就開一個新的
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./rp-chat.html');
    })
  );
});
