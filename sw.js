// Procrastinote's background helper (service worker).
// It shows phone notifications, including when the site is closed, and opens the right page
// when one is tapped. It doesn't cache anything, so the site always loads fresh.
//
// Notifications arrive two ways:
// 1. From the site itself while it is open in the background (school-app.js -> showNotification)
// 2. As "push" messages from Supabase when the site is closed (supabase/functions/send-push),
//    once phone notifications are switched on in Supabase (see SUPABASE_SETUP.md).
//    Push data: { title, body, url, tag }

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (e) {
        data = { body: event.data ? event.data.text() : '' };
    }
    event.waitUntil((async () => {
        // Someone looking at the site right now already sees it there
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (windows.some(w => w.visibilityState === 'visible' && w.focused)) return;
        await self.registration.showNotification(data.title || 'Procrastinote', {
            body: data.body || '',
            icon: 'icon-192.png',
            badge: 'icon-maskable-192.png',
            tag: data.tag || undefined, // the same tag replaces an older notification instead of stacking
            data: { url: data.url || '/' }
        });
    })());
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const open = windows.find(w => new URL(w.url).origin === self.location.origin);
        if (open) {
            await open.focus();
            open.postMessage({ type: 'open-from-notification', url: target });
            return;
        }
        await self.clients.openWindow(target);
    })());
});
