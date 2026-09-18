import {
  useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
} from 'react';
import { createRoot } from 'react-dom/client';
import { DateTime } from 'luxon';
import type { AwayEntry, WeeklyBlock } from '../../atproto/records.js';
import {
  buildGeom, applyPaint, paintToIntervals, intervalsToPaint, type PaintMap,
} from '../../core/gridModel.js';
import { hourRows, hourState, hourStrokeOp, hourRectKeys, type HourCell } from '../../core/hourCells.js';
import {
  describeWeekly, endOfLocalDay, normalizeAvailability, splitAtTemplateStart, templateSlots,
  templateIntervalsToWeekly, weeklyOverDates, weeklyToTemplateIntervals, TEMPLATE_START,
} from '../../core/availability.js';
import {
  compactAway, expandAway, paintAway, toggleAllDay, type AwayDays,
} from '../../core/awayDays.js';
import { materializeSlots } from '../../core/slots.js';
import { dateRangeLabel, domOf, localToday, mondayOf, plusDays } from '../../core/weekView.js';
import { WeekPicker, type Page } from './weekPicker.js';
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

/** `this week`, `next week`, `in 3 weeks` — the pager's name for a dated page. */
const pageName = (off: number) => (off === 0 ? 'this week' : off === 1 ? 'next week' : `in ${off} weeks`);

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
  const [page, setPage] = useState<Page>('usual');
  const [pickerOpen, setPickerOpen] = useState(false);
  // "Today" is read once, in the record's zone: an editor left open across midnight keeps
  // the page it is on rather than shifting under the pointer.
  const [now] = useState(() => new Date());
  const today = useMemo(() => localToday(now, zone), [now, zone]);
  const thisMonday = useMemo(() => mondayOf(today), [today]);
  /** The week offset on screen, or null on the usual week: the one page/date narrowing. */
  const off = page === 'usual' ? null : page;
  const dated = off !== null;
  /** The seven dates the page shows, or null on the usual week (which has no dates). */
  const dates = useMemo(() => (off === null
    ? null
    : Array.from({ length: 7 }, (_, i) => plusDays(thisMonday, off * 7 + i))), [off, thisMonday]);
  // A dated page is the same grid over real dates: same 7am-to-midnight window, same
  // half-hour slots, so the hour rows and the stroke geometry are the template's.
  const slots = useMemo(() => (dates
    ? materializeSlots({
      dates, window: { start: TEMPLATE_START, end: '00:00' }, slotMinutes: 30, timezone: zone,
    })
    : templateSlots(zone)), [dates, zone]);
  const geom = useMemo(() => buildGeom(slots, zone), [slots, zone]);
  // Hour rows over the half-hour slots (core/hourCells.ts): the record stays half-hour
  // aligned; the grid draws and strokes by the hour.
  const hours = useMemo(() => hourRows(geom, zone), [geom, zone]);
  // The element under a moving pointer names its hour by the hour's first slot key.
  const cellByKey = useMemo(() => {
    const m = new Map<string, HourCell>();
    for (const r of hours) for (const c of r.cells) if (c) m.set(c.keys[0], c);
    return m;
  }, [hours]);
  /** Each slot key as the date and half hour it falls on in the record's zone. */
  const local = useMemo(() => {
    const m = new Map<string, { date: string; hm: string }>();
    for (const s of slots) {
      const d = DateTime.fromISO(s.start, { zone: 'utc' }).setZone(zone);
      m.set(s.start, { date: d.toISODate()!, hm: d.toFormat('HH:mm') });
    }
    return m;
  }, [slots, zone]);
  /** Where each hour cell sits, for the note chip's anchor (Task 12). */
  const pos = useMemo(() => {
    const m = new Map<string, { ri: number; ci: number }>();
    hours.forEach((r, ri) => r.cells.forEach((c, ci) => { if (c) m.set(c.keys[0], { ri, ci }); }));
    return m;
  }, [hours]);

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
  /** The usual week's free hours, drawn on whichever seven dates are on screen. */
  const painted = useMemo<PaintMap>(() => intervalsToPaint(
    dates ? weeklyOverDates(weekly, dates, zone) : weeklyToTemplateIntervals(weekly, zone),
    [], slots,
  ), [weekly, dates, zone, slots]);
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
  /** The away day map for the week on screen: what a stroke on a dated page edits. */
  const days = useMemo<AwayDays>(
    () => (dates ? expandAway(away, dates[0], dates[6]) : new Map()), [away, dates]);
  /** Any away at all in this hour cell — half an hour of it is enough to colour the cell. */
  const awayAt = (c: HourCell): boolean => {
    const at = local.get(c.keys[0]);
    const d = at && days.get(at.date);
    if (!d) return false;
    const set = d.away;
    if (set === 'all') return true;
    return c.keys.some((k) => {
      const l = local.get(k);
      return !!l && set.has(l.hm);
    });
  };
  /** The picker's orange dots. */
  const hasAway = (date: string) => away.some((a) => a.start <= date && date <= a.end);
  // Stable: it is the picker's outside-click effect's only dependency, so an unstable one
  // would tear the listeners down and re-arm them — grace tick and all — on every render.
  const closePicker = useCallback(() => setPickerOpen(false), []);
  /** A page change: dismiss what belonged to the old page. */
  const switchPage = (next: Page) => {
    if (next === page) return;
    setPickerOpen(false);
    setPage(next);
  };
  // What the server has been told about away, entry by entry, so a new one can say it is
  // not up yet: "i'm away" only adds to this list, and the post button — a long page below
  // — is what publishes. Compared as JSON: the editor builds entries in the same key order
  // the record comes back in (start, end, startTime, endTime, note).
  const [postedAway, setPostedAway] = useState<Set<string>>(
    () => new Set(data.away.map((a) => JSON.stringify(a))));
  const unposted = (a: AwayEntry) => !postedAway.has(JSON.stringify(a));
  const [note, setNote] = useState(data.note);
  const [validUntil, setValidUntil] = useState(data.validUntil);
  const [alias, setAlias] = useState(data.alias);
  const [aliasSaved, setAliasSaved] = useState(data.aliasSaved);
  const aliasOk = alias === '' || isValidSezName(alias);
  // A name that breaks the rule has no address to promise: the rule hint under the field
  // says why, and the line below the grid falls back to "no address yet" rather than
  // reading out a host that could never be claimed.
  const address = alias ? (aliasOk ? `${alias}.${data.sezSuffix}` : null) : data.addressFallback;
  const [saving, setSaving] = useState(false);
  // What the server already has. The button lights up only when the editor differs from it —
  // an editor with no record to open stands at "nothing marked", which is not worth posting.
  const [savedAt, setSavedAt] = useState(
    snapshot(data.weekly, data.away, data.note, data.validUntil, data.timezone ?? HERE, data.aliasSaved));
  const dirty = savedAt !== snapshot(weekly, away, note, validUntil, zone, alias);

  // ---- the stroke, as in grid.tsx
  const drag = useRef<{ anchor: HourCell; op: 'add' | 'remove'; base: PaintMap; touch: boolean } | null>(null);
  // A finger resting on a cell that is not yet a stroke: a stroke if it holds for HOLD_MS, a
  // tap if it lifts first, nothing if the browser turns its movement into a scroll. `key` is
  // the hour cell's first slot key, which is what identifies the cell under the finger.
  const press = useRef<{ key: string; timer: number } | null>(null);
  const gridEl = useRef<HTMLDivElement>(null);
  const wrapEl = useRef<HTMLDivElement>(null);
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
  const paintTo = (cell: HourCell) => {
    const d = drag.current;
    if (!d) return;
    setPainted(applyPaint(d.base, hourRectKeys(hours, d.anchor, cell), d.op, 'available'));
  };
  const startStroke = (cell: HourCell, touch: boolean) => {
    // A dated page draws the record and takes no marks yet.
    if (dated) return;
    drag.current = { anchor: cell, op: hourStrokeOp(painted, cell), base: painted, touch };
    paintTo(cell);
  };
  const onDown = (cell: HourCell) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') {
      cancelPress();
      press.current = {
        key: cell.keys[0],
        timer: window.setTimeout(() => {
          press.current = null;
          startStroke(cell, true);
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
    startStroke(cell, false);
  };
  // A finger that lifts before the hold fires is a tap: mark (or unmark) that one hour.
  const onUp = (cell: HourCell) => () => {
    if (press.current?.key !== cell.keys[0]) return;
    cancelPress();
    startStroke(cell, true);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    // `.cell[data-slot]` skips the unmarkable `.cell.gap` row-fillers.
    const hit = el instanceof Element ? el.closest<HTMLElement>('.cell[data-slot]') : null;
    const hourCell = hit?.dataset.slot ? cellByKey.get(hit.dataset.slot) : undefined;
    if (hourCell) paintTo(hourCell);
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
      setPostedAway(new Set(away.map((a) => JSON.stringify(a))));
      setSavedAt(snapshot(weekly, away, note, validUntil, zone, alias));
      setStatus(out.written ? 'availability posted.' : 'nothing changed.');
    } catch {
      setStatus('could not reach the server.');
    } finally {
      setSaving(false);
    }
  };

  const cell = (c: HourCell, label: string, isAway: boolean) => {
    const state = hourState(painted, c);
    return (
      <div
        key={c.keys[0]}
        className={cn('cell', state !== 'none' && state, isAway && 'away')}
        data-slot={c.keys[0]}
        title={label}
        onPointerDown={onDown(c)}
        onPointerUp={onUp(c)}
      />
    );
  };

  return (
    <div>
      <div className="pager-wrap">
        <div className={cn('pager', dated && 'dated')}>
          <button
            type="button"
            className="arrow"
            aria-label="previous week"
            disabled={off === null}
            onClick={() => switchPage(off !== null && off > 0 ? off - 1 : 'usual')}
          >‹</button>
          {/* Always two lines — a name over a date range, or over "repeats every week" — so
              the pager's height never moves when the page changes. */}
          <button
            type="button"
            className="label"
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            title="pick a week"
            onClick={() => setPickerOpen((o) => !o)}
          >
            <span className="name">{off === null ? 'usual week' : pageName(off)}</span>
            <small>{dates ? dateRangeLabel(dates[0], dates[6]) : 'repeats every week'}</small>
          </button>
          <button
            type="button"
            className="arrow"
            aria-label="next week"
            onClick={() => switchPage(off === null ? 0 : off + 1)}
          >›</button>
        </div>
        {pickerOpen && (
          <WeekPicker
            page={page}
            today={today}
            thisMonday={thisMonday}
            hasAway={hasAway}
            onPick={(p) => { switchPage(p); setPickerOpen(false); }}
            onClose={closePicker}
          />
        )}
      </div>
      <p className="hint">{dated
        ? 'free hours come from your usual week. drag hours to mark away. tap a day for all day.'
        : "mark when you're usually free. this is a public record in your own repo, like your polls."}</p>
      {/* Above the grid, which is taller than a phone screen: read before the first touch. */}
      <p className="hint touch-hint">tap an hour to mark it. hold, then drag, for a block.</p>
      <div className="gridwrap" ref={wrapEl}>
        <div
          ref={gridEl}
          className={cn('grid canvas', dated ? 'dated' : 'usual')}
          onPointerMove={onMove}
        >
          <div className="col axis">
            <div className="col-head" />
            <div className="cells">
              {hours.map((r) => (
                <div key={r.hour} className="axis-label">{r.label}</div>
              ))}
            </div>
          </div>
          {geom.dates.map((d, ci) => (
            <div
              className={cn('col', dated && d < today && 'past')}
              key={d}
              data-c={ci}
              style={{ '--i': ci + 1 } as CSSProperties}
            >
              <div
                className={cn('col-head', dated && d === today && 'today')}
                data-c={ci}
              >
                {/* Empty on the usual week, which has no dates — the row keeps its height. */}
                <span className="num">{dated ? domOf(d) : ''}</span>
                <span className="dow">{DOW[new Date(`${d}T12:00:00Z`).getUTCDay()]}</span>
              </div>
              <div className="cells">
                {hours.map((r) => {
                  const c = r.cells[ci];
                  // No slot at this hour on this day (a DST edge): hold the row open with an
                  // unmarkable blank so the columns stay aligned.
                  return c
                    ? cell(c, r.label, dated && awayAt(c))
                    : <div key={`gap-${r.hour}`} className="cell gap" aria-hidden="true" />;
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      {dated && (
        <p className="caption hint">what friends see this week. <b>marks here are away</b>, and stick to the date.</p>
      )}
      {dated && (
        <div className="week-legend">
          <span><i className="free" />usually free</span>
          <span><i className="away" />away</span>
        </div>
      )}
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
            {unposted(a) && <span className="unposted">not posted yet</span>}
            <button
              type="button"
              className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
              onClick={() => setAway(away.filter((_, j) => j !== i))}
            >remove</button>
          </li>
        ))}
        {away.length === 0 && <li className="hint">nothing yet. your usual week stands as-is.</li>}
      </ul>
      {away.some(unposted) && <p className="hint away-hint">post availability below to publish these.</p>}
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
      <div className="details">
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
        <label>good through
          <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
        </label>
        <label className="full">note for friends
          <input
            type="text"
            maxLength={300}
            placeholder="text me first, weeknights are flexible"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <label className="full">your address
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
      </div>
      {zoneText !== zone && (
        <p className="hint">not a timezone this browser knows. still using {zone}.</p>
      )}
      {!aliasOk && <p className="hint">{SEZ_NAME_RULE}</p>}
      <p className="note">this record is public, like your polls. anyone with your handle can read it.</p>
      {/* Sticky at the bottom of the viewport while the editor is on screen: the page is
          long, and a change made at the top must not hide the one button that saves it. */}
      <div className="save-bar">
        <button
          type="button"
          className={cn(buttonVariants({ variant: 'default' }), 'save')}
          disabled={saving || !dirty || !aliasOk}
          onClick={submit}
        >post availability</button>
        {status && <p className="status" role="status">{status}</p>}
      </div>
    </div>
  );
}

const dataEl = document.getElementById('availability-data');
const mount = document.getElementById('availability-root');
if (dataEl?.textContent && mount) {
  createRoot(mount).render(<Editor data={JSON.parse(dataEl.textContent) as AvailabilityData} />);
}
