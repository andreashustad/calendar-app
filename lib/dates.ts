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

export function weekBoundsISO(dateStr: string): { startISO: string; endISO: string } {
  const d = new Date(dateStr);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
  const startOfWeek = new Date(d.setDate(diff));
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);

  const dStart = new Date(`${isoDate(startOfWeek)}T00:00:00`);
  const dEnd = new Date(`${isoDate(endOfWeek)}T23:59:59`);
  
  return { startISO: dStart.toISOString(), endISO: dEnd.toISOString() };
}