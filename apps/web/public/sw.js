const CACHE = "remote-lab-v5";
const ARTWORK_CACHE = "olive-artwork-v2";
const MAX_ARTWORK_ENTRIES = 500;
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg"];
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL))));
self.addEventListener("activate", (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key !== ARTWORK_CACHE).map((key) => caches.delete(key))))));

async function trimArtworkCache(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ARTWORK_ENTRIES)).map((key) => cache.delete(key)));
}

async function cachedArtwork(request) {
  const cache = await caches.open(ARTWORK_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === "opaque") {
    await cache.put(request, response.clone());
    await trimArtworkCache(cache);
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const path = new URL(event.request.url).pathname;
  if (event.request.destination === "image" || path === "/api/artwork") {
    event.respondWith(cachedArtwork(event.request));
    return;
  }
  if (path.startsWith("/api/")) return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request)));
});
