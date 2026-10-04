const CACHE = 'coach-v2'

self.addEventListener('install', e => {
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.map(k => caches.delete(k)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', e => {
  const req = e.request
  if (req.method !== 'GET' || req.url.includes('/api/')) return
  e.respondWith((async () => {
    try {
      const res = await fetch(req)
      const cache = await caches.open(CACHE)
      cache.put(req, res.clone())
      return res
    } catch (err) {
      const cached = await caches.match(req)
      if (cached) return cached
      throw err
    }
  })())
})
