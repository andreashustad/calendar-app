export async function backoff(resp?: Response, baseMs = 1000, capMs = 8000) {
  // Respekter Retry-After om satt
  const retryAfter = resp?.headers.get("Retry-After");
  if (retryAfter) {
    const sec = Number(retryAfter);
    if (!Number.isNaN(sec)) {
      await sleep((sec + Math.random()) * 1000);
      return;
    }
  }
  // Eksponentiell backoff m/ jitter
  const ms = Math.min(baseMs * (1 + Math.random() * 2), capMs);
  await sleep(ms);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
