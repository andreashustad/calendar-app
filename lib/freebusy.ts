export type Interval = { start: Date; end: Date };

// Slår sammen overlappende intervaller
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Interval[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    if (curr.start <= prev.end) {
      // overlap -> utvid
      prev.end = new Date(Math.max(prev.end.getTime(), curr.end.getTime()));
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

export function clampToWorkday(intervals: Interval[], date: Date, workStart = 8, workEnd = 17): Interval[] {
  const dayStart = new Date(date);
  dayStart.setHours(workStart, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(workEnd, 0, 0, 0);

  return intervals
    .map(i => ({
      start: new Date(Math.max(i.start.getTime(), dayStart.getTime())),
      end: new Date(Math.min(i.end.getTime(), dayEnd.getTime()))
    }))
    .filter(i => i.end > i.start);
}

export function invertBusyToFree(busy: Interval[], date: Date, workStart = 8, workEnd = 17, minMinutes = 30): Interval[] {
  const dayStart = new Date(date);
  dayStart.setHours(workStart, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(workEnd, 0, 0, 0);

  const merged = mergeIntervals(clampToWorkday(busy, date, workStart, workEnd));
  const free: Interval[] = [];
  let cursor = dayStart;
  for (const b of merged) {
    if (b.start > cursor) free.push({ start: new Date(cursor), end: new Date(b.start) });
    if (b.end > cursor) cursor = b.end;
  }
  if (cursor < dayEnd) free.push({ start: new Date(cursor), end: new Date(dayEnd) });

  return free.filter(i => (i.end.getTime() - i.start.getTime()) / 60000 >= minMinutes);
}
