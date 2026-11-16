// يحفظ ملفات الواجهة فقط ليفتح التطبيق بسرعة وبدون إنترنت. البيانات المالية لا تُخزَّن هنا.
const CACHE = 'nasser-v6';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('nasser-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // الشبكة أولًا ليصل أي تحديث للتطبيق فورًا، ثم النسخة المحفوظة عند انقطاع الإنترنت
  e.respondWith(
    // no-cache: يسأل الخادم دائمًا عن أحدث نسخة بدل الاعتماد على ذاكرة المتصفح (كانت تؤخر ظهور التحديثات)
    fetch(req.url, { cache: 'no-cache' }).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
