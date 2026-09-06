// Pathshala guardian PWA v0: offline shell for the portal, background ping of the scheduler heartbeat, push display.
const CACHE = 'pathshala-v1';
const SHELL = ['/portal', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => undefined))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });

// network first for pages/API, cache fallback for the shell; assets are immutable so cache-first
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/assets/')) { e.respondWith(caches.open(CACHE).then(c => c.match(e.request).then(r => r || fetch(e.request).then(res => { c.put(e.request, res.clone()); return res; })))); return; }
  e.respondWith(fetch(e.request).then(res => { if (url.pathname.startsWith('/portal')) caches.open(CACHE).then(c => c.put(e.request, res.clone())); return res; }).catch(() => caches.match(e.request).then(r => r || caches.match('/portal'))));
});

// Web Push → notification; click → open the portal
self.addEventListener('push', e => {
  let data = { title: 'Pathshala', body: '' };
  try { data = { ...data, ...e.data.json() }; } catch { data.body = e.data ? e.data.text() : ''; }
  e.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: '/icon.svg', badge: '/icon.svg', data: { url: data.url || '/portal' }, tag: data.tag }));
});
self.addEventListener('notificationclick', e => { e.notification.close(); e.waitUntil(clients.openWindow((e.notification.data && e.notification.data.url) || '/portal')); });

// Heartbeat: when the app is opened, poke the scheduler so due jobs run even on hosts without cron (docs/HOSTING-CPANEL.md §3)
self.addEventListener('message', e => { if (e.data === 'heartbeat') fetch('/_health', { cache: 'no-store' }).catch(() => undefined); });
