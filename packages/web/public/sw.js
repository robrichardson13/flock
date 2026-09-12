/** Hard ceiling on any one sweep; mirrors `CLOSE_LIMIT` in packages/web/src/push.ts. */
const CLOSE_LIMIT = 100;

// Take over as soon as a new version is served: this worker caches nothing, so there is no
// in-flight state to protect and a stale push handler is the only failure mode worth avoiding.
self.addEventListener("install", (e) => e.waitUntil(self.skipWaiting()));
// What the activate sweep saw, so the page can report it (card 70). A notification that belongs
// to a previous registration shows up here and nowhere else. Two numbers, overwritten each time.
let activateSeen = -1;
let activateClosed = -1;

self.addEventListener("activate", (e) => e.waitUntil((async () => {
  await self.clients.claim();
  // Sweep the tray on activate. A new worker inherits the *same registration* as the one it
  // replaces, so notifications the previous worker showed are still ours to close — and after an
  // app update they are the ones most likely to be stale, since the page that would have
  // dismissed them was running the old code. Bounded like every other sweep.
  const r = await closeAllNotifications(CLOSE_LIMIT);
  activateSeen = r.seen;
  activateClosed = r.closed;
})()));

// The page asks for this the moment it comes to the front (see `askWorkerToCloseAll` in
// packages/web/src/push.ts). The worker does the closing itself because a worker enumerating its
// own notifications is reliable on WebKit, where the same call from the page can come back empty.
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "flock:close-all") return;
  const limit = typeof data.limit === "number" && data.limit > 0 ? Math.min(data.limit, CLOSE_LIMIT) : CLOSE_LIMIT;
  // The page hands us a MessagePort to answer on. Without it, "the worker never got the message"
  // and "the worker got it and saw an empty tray" are the same silence from the page's side, and
  // that ambiguity is what card 70 is stuck on. Answering is best-effort: an old page that sent
  // no port still gets its sweep.
  const reply = event.ports && event.ports[0];
  event.waitUntil((async () => {
    const r = await closeAllNotifications(limit);
    if (!reply) return;
    try {
      reply.postMessage({
        type: "flock:close-all:done",
        seen: r.seen,
        closed: r.closed,
        err: r.err,
        activateSeen,
        activateClosed,
      });
    } catch (err) {
      // A closed port is normal (the page went away mid-sweep) and is not worth failing over.
      console.warn("[sw] close-all reply failed", err);
    }
  })());
});

/** Closes every notification this registration has shown, bounded. Returns `{ seen, closed, err }`
 *  — `seen` is the whole point on WebKit, where an empty enumeration is the suspected failure and
 *  a bare count of closures cannot tell it from an empty tray. Never throws: it runs from event
 *  handlers where a rejection would be reported as a worker error and nothing else. */
async function closeAllNotifications(limit) {
  try {
    const open = await self.registration.getNotifications();
    let closed = 0;
    for (const n of open) {
      if (closed >= limit) break;
      n.close();
      closed++;
    }
    return { seen: open.length, closed, err: null };
  } catch (err) {
    console.warn("[sw] closeAllNotifications failed", err);
    return { seen: -1, closed: 0, err: String((err && err.message) || err).slice(0, 120) };
  }
}

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
      // Chrome/Edge silently swallow a same-tag replacement's alert unless renotify is set; the
      // pump now sets it true on a leading edge/ask, false on a quiet trailing flush. The `&&`
      // guard is belt and braces (Chrome throws if renotify is true with an empty tag, which
      // never happens here since tag falls back to url above); old service workers ignoring the
      // field is fine, renotify is an enhancement only (§2.6).
      renotify: p.renotify === true && !!(p.tag || p.url),
      data: { url: p.url },
      icon: "/icon-v2-192.png",
      badge: "/badge-v2-96.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  n.close();
  const url = (n.data && n.data.url) || n.tag || "#/";
  event.waitUntil((async () => {
    await closeSiblingNotifications(n.tag);
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

// The board segment of a route tag (NotificationPayload's `tag` is always the route, e.g.
// "#/b/<slug>/channel" or "#/b/<slug>/c/12"), or null when `tag` isn't a board route. Kept in sync
// by hand with `boardPrefixOf` in packages/web/src/notifGroups.ts — that copy is the one covered
// by `bun test`; this file is plain JS with no imports, so it can't share the module directly.
function boardPrefixOf(tag) {
  const m = typeof tag === "string" && tag.match(/^#\/b\/[^/]+\//);
  return m ? m[0] : null;
}

// Tapping one notification for a board clears the rest of that board's stack too, rather than
// leaving stale banners behind for cards the person is about to see anyway. Bounded to 50: a
// board with a runaway number of open notifications must never turn one tap into an unbounded
// loop. A tag outside the board-route shape (e.g. none set) closes nothing beyond the tapped one.
async function closeSiblingNotifications(tappedTag) {
  const prefix = boardPrefixOf(tappedTag);
  if (!prefix) return;
  const open = await self.registration.getNotifications();
  let closed = 0;
  for (const other of open) {
    if (closed >= 50) break;
    if (other.tag === tappedTag) continue;
    if (boardPrefixOf(other.tag) !== prefix) continue;
    other.close();
    closed++;
  }
}
