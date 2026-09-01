export interface Interval {
  start: string; // UTC ISO, normalized
  end: string;   // UTC ISO, normalized; end > start
}

export function normalizeIso(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid datetime: ${s}`);
  return d.toISOString();
}

/** Sort, validate, and merge overlapping/touching intervals. Pure. */
export function mergeIntervals(ivs: Interval[]): Interval[] {
  const norm = ivs.map((i) => ({ start: normalizeIso(i.start), end: normalizeIso(i.end) }));
  for (const i of norm) {
    if (i.end <= i.start) throw new Error(`invalid interval: ${i.start}..${i.end}`);
  }
  norm.sort((a, b) => a.start.localeCompare(b.start));
  const out: Interval[] = [];
  for (const i of norm) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) {
      if (i.end > last.end) last.end = i.end;
    } else {
      out.push({ ...i });
    }
  }
  return out;
}

/** A slot survives only if some painted interval fully covers it. Result is merged. */
export function snapToSlots(ivs: Interval[], slots: Interval[]): Interval[] {
  const merged = mergeIntervals(ivs);
  const covered = slots.filter((s) =>
    merged.some((m) => m.start <= s.start && m.end >= s.end),
  );
  return covered.length ? mergeIntervals(covered) : [];
}
