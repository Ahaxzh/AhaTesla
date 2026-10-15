/* AhaTesla Service Worker — HTML network-first（发版即生效），带 hash 静态资源 cache-first，API network-first，离线兜底 */
const VERSION = 'v3'
const SHELL_CACHE = `ahatesla-shell-${VERSION}`
const SHELL_ASSETS = ['/manifest.json', '/favicon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // API：network-first，失败时回退缓存
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone()
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy))
          return res
        })
        .catch(() => caches.match(request)),
    )
    return
  }

  // 页面导航（/ 与 /index.html）：network-first —— HTML 里的带 hash 资源名变了就自动用新版本
  if (request.mode === 'navigate' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy))
          }
          return res
        })
        .catch(() => caches.match(request).then((c) => c || caches.match('/index.html'))),
    )
    return
  }

  // 带 hash 的构建产物与其他静态资源：cache-first，后台更新
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy))
          }
          return res
        })
        .catch(() => cached || caches.match('/index.html'))
      return cached || network
    }),
  )
})
