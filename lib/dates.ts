export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function localTZ(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Oslo";
}

export function dayBoundsISO(dateStr: string): { startISO: string; endISO: string } {
  const dStart = new Date(`${dateStr}T00:00:00`);
  const dEnd = new Date(`${dateStr}T23:59:59`);
  return { startISO: dStart.toISOString(), endISO: dEnd.toISOString() };
}
