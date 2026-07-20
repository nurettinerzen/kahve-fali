// Çiftler Düellosu — service worker
// Amaç: PWA kurulabilirliği + statik dosyaları önbellekten hızlı açmak.
// /api/* ASLA önbelleğe girmez — oyun durumu her zaman taze.

const SURUM = "duello-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((k) => Promise.all(k.filter((x) => x !== SURUM).map((x) => caches.delete(x)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;

  // ağ öncelikli, kopamazsak önbellek (statikler için)
  e.respondWith(
    (async () => {
      try {
        const yanit = await fetch(e.request);
        if (yanit.ok && url.origin === location.origin) {
          const onbellek = await caches.open(SURUM);
          onbellek.put(e.request, yanit.clone());
        }
        return yanit;
      } catch {
        const eski = await caches.match(e.request);
        if (eski) return eski;
        throw new Error("çevrimdışı");
      }
    })()
  );
});
