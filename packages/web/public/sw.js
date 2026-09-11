// Take over as soon as a new version is served: this worker caches nothing, so there is no
// in-flight state to protect and a stale push handler is the only failure mode worth avoiding.
self.addEventListener("install", (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// EVERY push must end in a visible notification. We subscribe with userVisibleOnly: true, and
// WebKit revokes the whole subscription if a push arrives and nothing is shown — so the fallback
// below is not politeness, it is what keeps the subscription alive when a payload is malformed.
self.addEventListener("push", (event) => {
  let p = { title: "flock", body: "Something needs you.", url: "#/", tag: "#/" };
  try { if (event.data) p = { ...p, ...event.data.json() }; } catch {}
  event.waitUntil(
    self.registration.showNotification(p.title, {
      body: p.body,
      // The tag is the route (see NotificationPayload): Safari does not reliably hand `data`
      // back to notificationclick, and the tag always survives. `data` is set anyway for the
      // browsers that do honour it — the click handler prefers it and falls back to the tag.
      tag: p.tag || p.url,
      data: { url: p.url },
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const n = event.notification;
  const url = (n.data && n.data.url) || n.tag || "#/";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin !== self.location.origin) continue;
      await c.focus();
      // postMessage is the primary route, not the fallback. `client.navigate` requires the
      // client to be *controlled* by this worker, which includeUncontrolled:true explicitly
      // does not guarantee, and a hash-only navigate is not guaranteed to re-run a hash router
      // anyway. The page listens for this message and sets location.hash itself.
      c.postMessage({ type: "flock:navigate", url });
      return;
    }
    await self.clients.openWindow(new URL(url, self.location.origin).href);
  })());
});
