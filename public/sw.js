// Minimal SW kun for installasjonssymbol (ingen caching av API)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
// Bevisst ingen fetch-handler -> ingen caching, ingen nettverksintercept.
