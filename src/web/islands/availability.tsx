import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { AwayEntry, WeeklyBlock } from '../../atproto/records.js';
import {
  buildGeom, strokeOp, rectKeys, applyPaint, paintToIntervals, intervalsToPaint, type PaintMap,
} from '../../core/gridModel.js';
import {
  describeWeekly, endOfLocalDay, normalizeAvailability, splitAtTemplateStart, templateSlots,
  templateIntervalsToWeekly, weeklyToTemplateIntervals,
} from '../../core/availability.js';
import { UserError } from '../../core/errors.js';
import { isValidSezName, SEZ_NAME_RULE } from '../../core/sezName.js';
// Only the class-string generator, never the <Button> component: <Button> stamps
// data-slot="button", which would land inside #availability-root and start matching the
// same `[data-slot]` selector the grid cells use.
import { buttonVariants } from '../ui/button.js';
import { cn } from '../lib/cn.js';

interface AvailabilityData {
  timezone: string | null;
  weekly: WeeklyBlock[];
  away: AwayEntry[];
  note: string;
  validUntil: string; // YYYY-MM-DD or ''
  alias: string;          // what the field opens with (the claim, or a suggestion)
  aliasSaved: string;     // the claim the server holds, '' for none
  sezSuffix: string;      // 'sez.letsmeet.lol'
  addressFallback: string | null; // the hyphenated-handle address, or null
}

/** How long a finger rests on a cell before it marks instead of scrolling — as in grid.tsx. */
const HOLD_MS = 350;
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Every zone this browser knows, for the timezone field's datalist. Empty where it can't say. */
const ZONES: string[] = (() => {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return []; }
})();

/** The viewer's own zone, for an editor that has no record (or one this browser can't use). */
const HERE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * A zone this browser can format in. The grid is built entirely out of `Intl` formatting in
 * the chosen zone, and `templateSlots` refuses one luxon does not know — both throw, and a
 * throw while rendering takes the whole editor down. So nothing reaches them unchecked.
 */
function knownZone(z: string): boolean {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: z }); return true; } catch { return false; }
}

/**
 * Minute-of-day of an instant in `zone` — the row axis. Slots on different days that start
 * at the same wall-clock time share a row, so each time is printed once, in the axis column.
 */
function minutesInZone(iso: string, zone: string): number {
  const [h, m] = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone,
  }).format(new Date(iso)).split(':').map(Number);
  return h * 60 + m;
}
function fmtAxisTime(iso: string, zone: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: zone });
}
/** A calendar date, read back in UTC from a noon anchor so no zone can shift the day. */
function fmtDate(d: string): string {
  return new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function fmtClock(t: string): string {
  const [h, m] = t.split(':').map(Number);
  const hour = ((h + 11) % 12) + 1;
  return `${hour}${m ? ':' + String(m).padStart(2, '0') : ''}${h >= 12 ? 'pm' : 'am'}`;
}

/** Everything a save compares against, as one string: the record plus the zone it is in. */
function snapshot(
  weekly: WeeklyBlock[], away: AwayEntry[], note: string, validUntil: string, zone: string | null,
  alias: string,
): string {
  return JSON.stringify({ weekly, away, note, validUntil, zone, alias });
}

/**
 * The usual week, marked on the poll grid over a synthetic template week. One mode only:
 * a cell is either free or it isn't — there is no "if need be" in a standing record.
 */
function Editor({ data }: { data: AvailabilityData }) {
  // `zone` is the grid's zone and what a save posts; it is always one this browser knows.
  // `zoneText` is what the field holds — the datalist filters as you type, so every
  // keystroke on the way to "America/New_York" passes through a zone that is not one.
  const [zone, setZone] = useState(
    data.timezone && knownZone(data.timezone) ? data.timezone : HERE);
  const [zoneText, setZoneText] = useState(data.timezone ?? HERE);
  const slots = useMemo(() => templateSlots(zone), [zone]);
  const geom = useMemo(() => buildGeom(slots, zone), [slots, zone]);
  const rows = useMemo(() => {
    const byMin = new Map<number, string>();
    for (const keys of geom.columns.values()) {
      for (const k of keys) {
        const min = minutesInZone(k, zone);
        if (!byMin.has(min)) byMin.set(min, k);
      }
    }
    return [...byMin.entries()].sort((a, b) => a[0] - b[0]);
  }, [geom, zone]);
  const colMaps = useMemo(
    () => geom.dates.map((d) => new Map(geom.columns.get(d)!.map((k) => [minutesInZone(k, zone), k]))),
    [geom, zone],
  );

  const [status, setStatus] = useState<string | null>(null);

  // Marks live as weekly blocks; the grid is a view of them in the current zone. Changing
  // the zone keeps the wall-clock blocks (a Tuesday 7pm stays a Tuesday 7pm).
  const [weekly, setWeekly] = useState<WeeklyBlock[]>(data.weekly);
  // The part of the week the grid has no row for, held aside for the life of the editor: a
  // stroke rebuilds everything the cells cover, so without this a record written elsewhere
  // would lose its small-hours blocks at the first touch. A record so odd that it cannot even
  // be split (times off the half hour, which only another client can write) holds nothing
  // aside rather than taking the editor down with it.
  const [offGrid] = useState<WeeklyBlock[]>(() => {
    try { return splitAtTemplateStart(data.weekly).offGrid; } catch { return []; }
  });
  const painted = useMemo<PaintMap>(
    () => intervalsToPaint(weeklyToTemplateIntervals(weekly, zone), [], slots), [weekly, zone, slots]);
  /**
   * A stroke, written back as the record: what the cells now say, plus the blocks the grid
   * cannot show, merged and re-sorted. The one thing that can be refused here is a week of
   * more separate blocks than the record holds — so it is said out loud, and the marks stay
   * as they were rather than the stroke vanishing.
   */
  const setPainted = (p: PaintMap) => {
    try {
      const marked = templateIntervalsToWeekly(paintToIntervals(p, slots, 'available'), zone);
      setWeekly(normalizeAvailability(
        { timezone: zone, weekly: [...offGrid, ...marked], away: [] }).weekly);
      setStatus(null);
    } catch (err) {
      setStatus(err instanceof UserError ? err.message : 'could not mark that.');
    }
  };

  const [away, setAway] = useState<AwayEntry[]>(data.away);
  const [note, setNote] = useState(data.note);
  const [validUntil, setValidUntil] = useState(data.validUntil);
  const [alias, setAlias] = useState(data.alias);
  const [aliasSaved, setAliasSaved] = useState(data.aliasSaved);
  const aliasOk = alias === '' || isValidSezName(alias);
  const address = alias ? `${alias}.${data.sezSuffix}` : data.addressFallback;
  const [saving, setSaving] = useState(false);
  // What the server already has. The button lights up only when the editor differs from it —
  // an editor with no record to open stands at "nothing marked", which is not worth posting.
  const [savedAt, setSavedAt] = useState(
    snapshot(data.weekly, data.away, data.note, data.validUntil, data.timezone ?? HERE, data.aliasSaved));
  const dirty = savedAt !== snapshot(weekly, away, note, validUntil, zone, alias);

  // ---- the stroke, as in grid.tsx
  const drag = useRef<{ anchor: string; op: 'add' | 'remove'; base: PaintMap; touch: boolean } | null>(null);
  // A finger resting on a cell that is not yet a stroke: a stroke if it holds for HOLD_MS, a
  // tap if it lifts first, nothing if the browser turns its movement into a scroll.
  const press = useRef<{ key: string; timer: number } | null>(null);
  const gridEl = useRef<HTMLDivElement>(null);
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  // A pointer released off the grid (or cancelled by the OS) must still end the stroke.
  useEffect(() => {
    const end = () => { cancelPress(); drag.current = null; };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, []);
  // Once a held finger is marking, its movement must not also scroll: `touch-action` can't
  // change mid-gesture and React's touch handlers are passive, so this is a native listener.
  useEffect(() => {
    const el = gridEl.current;
    if (!el) return;
    const block = (e: TouchEvent) => { if (drag.current?.touch) e.preventDefault(); };
    el.addEventListener('touchmove', block, { passive: false });
    return () => el.removeEventListener('touchmove', block);
  }, []);
  const paintTo = (key: string) => {
    const d = drag.current;
    if (!d) return;
    setPainted(applyPaint(d.base, rectKeys(geom, d.anchor, key), d.op, 'available'));
  };
  const startStroke = (key: string, touch: boolean) => {
    drag.current = { anchor: key, op: strokeOp(painted, key, 'available'), base: painted, touch };
    paintTo(key);
  };
  const onDown = (key: string) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') {
      cancelPress();
      press.current = {
        key,
        timer: window.setTimeout(() => {
          press.current = null;
          startStroke(key, true);
          // A nudge to say "you're marking now", where the device has one.
          try { navigator.vibrate?.(8); } catch { /* not this device */ }
        }, HOLD_MS),
      };
      return;
    }
    e.preventDefault();
    // Capture keeps the move stream coming when the pointer wanders off the cell; the
    // hit-testing below still uses the real element under it.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported id */ }
    startStroke(key, false);
  };
  // A finger that lifts before the hold fires is a tap: mark (or unmark) that one cell.
  const onUp = (key: string) => () => {
    if (press.current?.key !== key) return;
    cancelPress();
    startStroke(key, true);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    // `.cell[data-slot]` skips the unmarkable `.cell.gap` row-fillers.
    const cell = el instanceof Element ? el.closest<HTMLElement>('.cell[data-slot]') : null;
    if (cell?.dataset.slot) paintTo(cell.dataset.slot);
  };

  // ---- away entries
  const [form, setForm] = useState({ start: '', end: '', startTime: '', endTime: '', note: '' });
  const addAway = () => {
    if (!form.start) return;
    const entry: AwayEntry = { start: form.start, end: form.end || form.start };
    if (form.startTime && form.endTime) { entry.startTime = form.startTime; entry.endTime = form.endTime; }
    if (form.note.trim()) entry.note = form.note.trim();
    setAway([...away, entry].sort((a, b) => a.start.localeCompare(b.start)));
    setForm({ start: '', end: '', startTime: '', endTime: '', note: '' });
  };

  const submit = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch('/availability', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          timezone: zone, weekly, away, note, alias,
          // A date the viewer picked, good until the end of that day where they are —
          // end-of-day UTC would expire an American record the evening before.
          validUntil: validUntil ? endOfLocalDay(validUntil, zone) : undefined,
        }),
      });
      const out = (await res.json().catch(() => ({}))) as
        { ok?: boolean; written?: boolean; error?: string };
      if (!res.ok) { setStatus(out.error ?? 'could not save.'); return; }
      setAliasSaved(alias);
      setSavedAt(snapshot(weekly, away, note, validUntil, zone, alias));
      setStatus(out.written ? 'availability posted.' : 'nothing changed.');
    } catch {
      setStatus('could not reach the server.');
    } finally {
      setSaving(false);
    }
  };

  const cell = (key: string) => (
    <div
      key={key}
      className={cn('cell', painted.has(key) && 'available')}
      data-slot={key}
      title={fmtAxisTime(key, zone)}
      onPointerDown={onDown(key)}
      onPointerUp={onUp(key)}
    />
  );

  return (
    <div>
      <label className="address">your address
        <span className="address-field">
          <input
            type="text"
            name="alias"
            maxLength={32}
            value={alias}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="pick a name"
            onChange={(e) => setAlias(e.target.value.trim().toLowerCase())}
          />
          <span className="suffix">.{data.sezSuffix}</span>
        </span>
      </label>
      {!aliasOk && <p className="hint">{SEZ_NAME_RULE}</p>}
      {/* Above the grid, which is taller than a phone screen: read before the first touch. */}
      <p className="hint touch-hint">tap a slot to mark it. hold, then drag, for a block. swipe to scroll.</p>
      <div ref={gridEl} className="grid canvas" onPointerMove={onMove}>
        <div className="col axis">
          <div className="col-head" />
          {rows.map(([min, sample]) => (
            <div key={min} className="axis-label">{fmtAxisTime(sample, zone)}</div>
          ))}
        </div>
        {geom.dates.map((d, ci) => (
          <div className="col" key={d}>
            <div className="col-head">
              <span className="dow">{DOW[new Date(d + 'T12:00:00Z').getUTCDay()]}</span>
            </div>
            {rows.map(([min]) => {
              const key = colMaps[ci].get(min);
              // No slot at this wall-clock time on this day (a DST edge): hold the row open
              // with an unmarkable blank so the columns stay aligned.
              return key ? cell(key) : <div key={`gap-${min}`} className="cell gap" aria-hidden="true" />;
            })}
          </div>
        ))}
      </div>
      <p className="sentence pixel-label" aria-live="polite">{describeWeekly(weekly)}</p>
      <p className="address-line pixel-label" aria-live="polite">
        {address ? `your address: ${address}` : 'no address yet. pick a name above.'}
        {alias !== aliasSaved && ' (not saved yet)'}
      </p>

      <h3 className="pixel-heading">away</h3>
      <p className="hint">dates that beat the usual week. leave the times empty for all day.</p>
      <ul className="away">
        {away.map((a, i) => (
          <li key={`${a.start}-${a.startTime ?? ''}-${i}`}>
            <span className="when">
              {a.start === a.end ? fmtDate(a.start) : `${fmtDate(a.start)} – ${fmtDate(a.end)}`}
              {/* Both are optional in the lexicon and only paired by our own normalize, so a
                  record written by another client can carry one without the other. */}
              {a.startTime && a.endTime && ` · ${fmtClock(a.startTime)}–${fmtClock(a.endTime)}`}
            </span>
            {a.note && <span className="note"> {a.note}</span>}
            <button
              type="button"
              className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
              onClick={() => setAway(away.filter((_, j) => j !== i))}
            >remove</button>
          </li>
        ))}
        {away.length === 0 && <li className="hint">nothing yet. your usual week stands as-is.</li>}
      </ul>
      <div className="away-form">
        <label>from <input type="date" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></label>
        <label>to <input type="date" value={form.end} min={form.start} onChange={(e) => setForm({ ...form, end: e.target.value })} /></label>
        <label>between <input type="time" step={1800} value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} /></label>
        <label>and <input type="time" step={1800} value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} /></label>
        <label>note <input type="text" maxLength={80} placeholder="out of town" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
        <button
          type="button"
          className={cn(buttonVariants({ variant: 'secondary' }), 'add-away')}
          disabled={!form.start}
          onClick={addAway}
        >i'm away</button>
      </div>

      <h3 className="pixel-heading">details</h3>
      <label>timezone
        <input
          type="text"
          value={zoneText}
          list="tz-list"
          onChange={(e) => {
            const v = e.target.value;
            setZoneText(v);
            if (knownZone(v)) setZone(v);
          }}
        />
        <datalist id="tz-list">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
      </label>
      {zoneText !== zone && (
        <p className="hint">not a timezone this browser knows. still using {zone}.</p>
      )}
      <label>good through <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></label>
      <label>note for friends
        <input
          type="text"
          maxLength={300}
          placeholder="text me first, weeknights are flexible"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <p className="note">this record is public, like your polls. anyone with your handle can read it.</p>
      <button
        type="button"
        className={cn(buttonVariants({ variant: 'default' }), 'save')}
        disabled={saving || !dirty || !aliasOk}
        onClick={submit}
      >post availability</button>
      {status && <p className="status" role="status">{status}</p>}
    </div>
  );
}

const dataEl = document.getElementById('availability-data');
const mount = document.getElementById('availability-root');
if (dataEl?.textContent && mount) {
  createRoot(mount).render(<Editor data={JSON.parse(dataEl.textContent) as AvailabilityData} />);
}
