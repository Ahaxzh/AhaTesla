/* AhaTesla Service Worker — HTML network-first（发版即生效），带 hash 静态资源 cache-first，API 不缓存（隐私），离线兜底 */
const VERSION = 'v5'
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

  // API：直连不落缓存。修复两点：
  // ① 认证 API（行程/GPS 轨迹/充电历史）曾被永久写进 Cache Storage，登出后
  //   仍留在共享机器上（隐私）；② 非 2xx 响应也被缓存，离线兜底会回放 500/401。
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request))
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

// ---- Web Push：展示通知(服务端 payload 形如 {title, body, url}) -----------------
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (e) {
    data = {}
  }
  const title = (data && data.title) || 'AhaTesla'
  const body = (data && data.body) || ''
  const url = (data && data.url) || '/'
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: (data && data.tag) || 'ahatesla',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url },
    }),
  )
})

// ---- 通知点击：聚焦已开的窗口(顺带导航到目标页)，没有则新开 --------------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of clientList) {
        if ('focus' in client) {
          await client.focus()
          // 已开窗口导航到通知目标页;跨源/失败不阻塞聚焦
          if ('navigate' in client) {
            try {
              await client.navigate(url)
            } catch (e) {
              /* 当前页保留 */
            }
          }
          return
        }
      }
      await self.clients.openWindow(url)
    })(),
  )
})
