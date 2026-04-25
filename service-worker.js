const CACHE_NAME = "rsvp-reader-v1";

const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./reader.js",
  "./epub.min.js",
  "./jszip.min.js", // 🔥 agregar esto
  "./manifest.json"
];

// instalar
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
});

// activar
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME)
            .map(k => caches.delete(k))
      )
    )
  );
});

// fetch (offline first)
self.addEventListener("fetch", e => {
  e.respondWith(
    caches.match(e.request).then(res => {
      return res || fetch(e.request);
    })
  );
});