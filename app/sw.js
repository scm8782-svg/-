// 오프라인에서도 앱 껍데기가 뜨도록 하는 최소한의 서비스 워커.
// usage.json 은 항상 네트워크 우선(실패 시 캐시 폴백).
const VERSION = "v2";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 서버(GitHub Actions)가 보낸 한도 알림을 표시한다.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data.json(); } catch {}
  e.waitUntil(
    self.registration.showNotification(d.title || "Claude 사용량", {
      body: d.body || "",
      tag: d.tag || "claude-usage",
      icon: "icon.svg",
      badge: "icon.svg",
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow("./"));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  if (url.pathname.endsWith("/usage.json")) {
    // 네트워크 우선: 성공하면 캐시 갱신, 실패하면 캐시로
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(url.pathname, copy));
          return res;
        })
        .catch(() => caches.match(url.pathname))
    );
    return;
  }

  // 앱 껍데기: 캐시 우선, 뒤에서 갱신
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fresh = fetch(e.request)
        .then((res) => {
          caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
