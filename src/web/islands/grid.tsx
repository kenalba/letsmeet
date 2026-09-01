import type { PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  buildGeom, strokeOp, rectKeys, applyPaint, paintToIntervals, intervalsToPaint,
  paintEquals, liveTally, paintEdges,
  type PaintMap, type PaintMode, type SlotCount,
} from '../../core/gridModel.js';
import type { Interval } from '../../core/intervals.js';
import { cn } from '../lib/cn.js';
// Only the class-string generator, never the <Button> component: <Button> stamps
// data-slot="button", which would land inside #grid-root and start matching the same
// `[data-slot]` selector the e2e grid-cell locator uses to find painted cells.
import { buttonVariants } from '../ui/button.js';

interface PollData {
  rkey: string;
  slots: Interval[];
  /** The poll's home zone. The grid opens in the viewer's zone and can toggle to this one. */
  timezone: string;
  viewerDid: string | null;
  editToken?: string;
  prefill?: { available: Interval[]; ifNeedBe: Interval[]; name?: string };
  /** The viewer's own name inside `counts`, when they have answered before. */
  self?: string;
  counts?: Record<string, SlotCount>;
  /** Poll is no longer active: show the same grid, but painting is off (the server would
   *  refuse the response anyway — see `services/responses.ts`). */
  readonly?: boolean;
}

const NO_COUNT: SlotCount = { available: [], ifNeedBe: [] };

function fmtTime(iso: string, zone: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', timeZone: zone,
  });
}

/**
 * `d` is already a calendar date *in the displayed zone* (buildGeom bucketed it there) — its
 * weekday is fixed regardless of viewing zone, so anchoring at noon UTC and formatting in UTC
 * reads back that same date `d` for any zone: no zone-aware math needed, unlike `fmtTime`.
 * Weekday and month-day are separate so the column head can stack them on two deliberate
 * lines instead of letting "Mon, Sep 14" wrap wherever the column width happens to break it.
 */
function fmtDow(d: string): string {
  return new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, {
    weekday: 'short', timeZone: 'UTC',
  });
}
function fmtDom(d: string): string {
  return new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

/** Axis labels drop the leading zero the in-title `fmtTime` keeps ("6:00 PM", not "06:00 PM"). */
function fmtAxisTime(iso: string, zone: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit', timeZone: zone,
  });
}

/**
 * Minute-of-day of an instant in `zone` — the row axis. Slots on different dates that start
 * at the same wall-clock time share a row, which is what lets each time be printed once, in
 * the axis column, instead of inside every cell of every column.
 */
function minutesInZone(iso: string, zone: string): number {
  const [h, m] = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone,
  }).format(new Date(iso)).split(':').map(Number);
  return h * 60 + m;
}

/**
 * How many *other* people have answered, for the heatmap denominator: the distinct names
 * appearing anywhere in `counts`, minus the viewer's own. The server only ships per-slot
 * name lists, so someone who responded without painting a single slot is invisible here
 * and is not counted — they also tint no cell, so the ratio stays within [0,1] and the
 * darkest cell still means "everyone we can see said yes". Duplicate display names
 * collapse into one responder.
 */
function countOthers(counts: Record<string, SlotCount> | undefined, self?: string): number {
  const names = new Set<string>();
  for (const c of Object.values(counts ?? {})) {
    for (const n of c.available) names.add(n);
    for (const n of c.ifNeedBe) names.add(n);
  }
  if (self) names.delete(self);
  return names.size;
}

const EDGE = 3;
const EDGE_SHADOW = {
  top: `inset 0 ${EDGE}px 0 0`, bottom: `inset 0 -${EDGE}px 0 0`,
  left: `inset ${EDGE}px 0 0 0`, right: `inset -${EDGE}px 0 0 0`,
} as const;

/**
 * One grid, not two. Every cell is tinted by how many people can make that slot, counting
 * the viewer's own unsaved paint as they go, and the viewer's paint is drawn as an outline
 * around each painted run (green for available, amber for if-need-be, which also carries a
 * faint hatch) rather than a fill — so the tint and the tally stay readable inside it.
 */
function Grid({ data }: { data: PollData }) {
  const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone || data.timezone;
  const [zone, setZone] = useState(viewerZone);
  const [mode, setMode] = useState<PaintMode>('available');
  const [name, setName] = useState(data.prefill?.name ?? '');
  const [status, setStatus] = useState<string | null>(null);
  const [editLink, setEditLink] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // What the server already has for this viewer; the save button lights up only when the
  // grid (or a guest's name) differs from it.
  const saved = useMemo<PaintMap>(() =>
    data.prefill
      ? intervalsToPaint(data.prefill.available, data.prefill.ifNeedBe, data.slots)
      : new Map(), []);
  const [painted, setPainted] = useState<PaintMap>(saved);

  // Columns are bucketed by calendar date *in the displayed zone*, so the whole geometry —
  // not just the labels — is rebuilt when the zone toggles.
  const geom = useMemo(() => buildGeom(data.slots, zone), [zone]);
  // The shared row axis: every wall-clock start time that occurs on any day, each holding a
  // sample slot key to format its label from. All days share one window today, so this is
  // normally exactly the first column's times — but a day that crosses a DST change can
  // shift, and its odd slots simply get rows of their own (other columns show a blank there).
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
  // Each column's slot key per axis row, so a cell can find its neighbours for the outline.
  const colMaps = useMemo(
    () => geom.dates.map((d) => new Map(geom.columns.get(d)!.map((k) => [minutesInZone(k, zone), k]))),
    [geom, zone],
  );
  const slotByKey = useMemo(() => new Map(data.slots.map((s) => [s.start, s])), []);
  const others = useMemo(() => countOthers(data.counts, data.self), []);
  // The viewer counts as a responder the moment they have painted anything.
  const responders = others + (painted.size > 0 ? 1 : 0);
  const locked = data.readonly === true;
  const dirty = !paintEquals(painted, saved)
    || name.trim() !== (data.prefill?.name ?? '').trim();
  const canSave = dirty && painted.size > 0 && (!!data.viewerDid || !!name.trim());

  const drag = useRef<{ anchor: string; op: 'add' | 'remove'; base: PaintMap } | null>(null);

  // A pointer released off the grid (or cancelled by the OS) must still end the stroke.
  useEffect(() => {
    const end = () => { drag.current = null; };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, []);

  const paintTo = (key: string) => {
    const d = drag.current;
    if (!d) return;
    setPainted(applyPaint(d.base, rectKeys(geom, d.anchor, key), d.op, mode));
  };

  const onDown = (key: string) => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    // Capture keeps the move stream coming even when the pointer wanders off the cell;
    // hit-testing below still uses the real element under the pointer.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported id */ }
    drag.current = { anchor: key, op: strokeOp(painted, key, mode), base: painted };
    paintTo(key);
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    // A cell with a tally has that span as its topmost element — climb to the cell that
    // owns it. `.cell[data-slot]` also skips the unpaintable `.cell.gap` row-fillers.
    const cell = el instanceof Element ? el.closest<HTMLElement>('.cell[data-slot]') : null;
    const key = cell?.dataset.slot;
    if (key) paintTo(key);
  };

  const submit = async () => {
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        available: paintToIntervals(painted, data.slots, 'available'),
        ifNeedBe: paintToIntervals(painted, data.slots, 'ifNeedBe'),
        timezone: viewerZone,
        editToken: data.editToken,
      };
      const url = data.viewerDid
        ? `/p/${data.rkey}/respond-auth`
        : `/p/${data.rkey}/respond`;
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = (await res.json().catch(() => ({}))) as
        { editToken?: string; pending?: boolean; error?: string };
      if (!res.ok) {
        setStatus(out.error ?? 'something broke. try again?');
        setSaving(false);
        return;
      }
      setStatus(out.pending
        ? 'response stored. syncing to the host’s repo behind the scenes.'
        : 'response stored.');
      // A token the guest does not already hold is the one thing on this page they cannot get
      // back: show it and let them reload on their own terms. Every other path (signed-in
      // submits, and edits made through a link they already have) reloads on a short timer.
      // `saving` deliberately stays true afterwards — re-saving without an edit token would
      // file a second, separate response rather than update this one.
      const fresh = out.editToken && out.editToken !== data.editToken ? out.editToken : null;
      if (fresh) setEditLink(`${location.origin}/p/${data.rkey}/e/${fresh}`);
      else setTimeout(() => location.reload(), 1200);
    } catch {
      setStatus('couldn’t reach the server. try again?');
      setSaving(false);
    }
  };

  const canSwitchZone = viewerZone !== data.timezone;

  const cell = (key: string, ci: number, ri: number) => {
    const end = slotByKey.get(key)!.end;
    const range = `${fmtTime(key, zone)}–${fmtTime(end, zone)}`;
    const mine = painted.get(key);
    // Everyone else's saved answer plus the viewer's current paint, so the numbers keep up
    // with the brush: "with you, 3 of 4 can make this".
    const c = liveTally(data.counts?.[key] ?? NO_COUNT, data.self, mine);
    const ratio = responders > 0 ? c.available.length / responders : 0;
    const tally = c.available.length + c.ifNeedBe.length;
    const title = responders === 0 ? range : [
      range,
      `Available (${c.available.length}/${responders}): ${c.available.join(', ') || 'nobody yet'}`,
      c.ifNeedBe.length ? `If need be: ${c.ifNeedBe.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    const edges = mine ? paintEdges(painted, key, {
      top: colMaps[ci].get(rows[ri - 1]?.[0]), bottom: colMaps[ci].get(rows[ri + 1]?.[0]),
      left: colMaps[ci - 1]?.get(rows[ri][0]), right: colMaps[ci + 1]?.get(rows[ri][0]),
    }) : [];
    const edgeColor = mine === 'available' ? 'var(--primary)' : 'var(--lol-bright)';
    return (
      <div
        key={key}
        data-slot={key}
        className={cn('cell', mine)}
        // Blue, not the brand green: the group's heat and the viewer's own picks must never
        // share a hue, and blue-vs-green also survives the common red-green colorblindness.
        // Only the colour is set inline, so the stylesheet's hatch image for if-need-be
        // still layers over it. Text color stays inherited (--card-foreground): it flips
        // with the theme, and it clears contrast on the tint at every ratio in both
        // palettes — a hardcoded white did not.
        style={{
          backgroundColor: ratio > 0 ? `rgba(59,130,246,${(0.15 + 0.85 * ratio).toFixed(3)})` : undefined,
          boxShadow: edges.length
            ? edges.map((side) => `${EDGE_SHADOW[side]} ${edgeColor}`).join(', ')
            : undefined,
        }}
        onPointerDown={locked ? undefined : onDown(key)}
        title={title}
      >
        {tally > 0 && (
          <span className="tally">
            {c.available.length}{c.ifNeedBe.length ? `+${c.ifNeedBe.length}` : ''}
          </span>
        )}
      </div>
    );
  };

  return (
    <div>
      <div className="toolbar">
        <div className="modes" role="group" aria-label="paint mode">
          <button
            type="button"
            className={cn(
              buttonVariants({ variant: mode === 'available' ? 'default' : 'outline', size: 'sm' }),
              mode === 'available' ? 'mode active' : 'mode',
            )}
            aria-pressed={mode === 'available'}
            disabled={locked}
            onClick={() => setMode('available')}
          >available</button>
          <button
            type="button"
            className={cn(
              buttonVariants({ variant: mode === 'ifNeedBe' ? 'default' : 'outline', size: 'sm' }),
              mode === 'ifNeedBe' ? 'mode active' : 'mode',
            )}
            aria-pressed={mode === 'ifNeedBe'}
            disabled={locked}
            onClick={() => setMode('ifNeedBe')}
          >if need be</button>
        </div>
        <button
          type="button"
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'zone')}
          disabled={!canSwitchZone}
          title={canSwitchZone
            ? `switch between your timezone (${viewerZone}) and the poll's (${data.timezone})`
            : "your timezone matches the poll's"}
          onClick={() => setZone(zone === viewerZone ? data.timezone : viewerZone)}
        >times shown in {zone}{canSwitchZone ? ' · switch' : ''}</button>
      </div>
      <div
        className={cn('grid', locked && 'readonly')}
        style={{ touchAction: 'none' }}
        onPointerMove={onMove}
      >
        <div className="col axis">
          <div className="col-head" />
          {rows.map(([min, sample]) => (
            <div key={min} className="axis-label">{fmtAxisTime(sample, zone)}</div>
          ))}
        </div>
        {geom.dates.map((d, ci) => {
          const byMin = colMaps[ci];
          return (
            <div className="col" key={d}>
              <div className="col-head">
                <span className="dow">{fmtDow(d)}</span>
                <span className="dom">{fmtDom(d)}</span>
              </div>
              {rows.map(([min], ri) => {
                const key = byMin.get(min);
                // No slot at this wall-clock time on this day (DST edge): hold the row
                // open with an unpaintable blank so the columns stay aligned. No
                // `data-slot`, so neither the e2e locator nor a drag stroke can hit it.
                return key
                  ? cell(key, ci, ri)
                  : <div key={`gap-${min}`} className="cell gap" aria-hidden="true" />;
              })}
            </div>
          );
        })}
      </div>
      {responders > 0 && (
        <p className="hint">
          {`blue shading counts how many of the ${responders} `
            + `${responders === 1 ? 'response' : 'responses'} can make each slot`}
          {locked
            ? '.'
            : ', your unsaved paint included. the green outline is you; amber hatching is your if-need-be.'}
        </p>
      )}
      {!data.viewerDid && !locked && (
        <label className="name">
          your name <span className="note">(shown on this poll)</span>
          {/* React's onChange is Preact's onInput: it fires on every keystroke. */}
          <input value={name} onChange={(e) => setName(e.currentTarget.value)} />
        </label>
      )}
      {!locked && (
        <button
          className={cn(buttonVariants({ variant: 'default' }), 'save')}
          type="button"
          onClick={submit}
          disabled={saving || !canSave}
        >save availability</button>
      )}
      {status && <p className="status" role="status">{status}</p>}
      {editLink && (
        <p className="edit-link">keep this link to edit your response later:<br /><code>{editLink}</code></p>
      )}
      {editLink && (
        <button
          type="button"
          className={cn(buttonVariants({ variant: 'secondary' }), 'show-results secondary')}
          onClick={() => location.reload()}
        >show results</button>
      )}
    </div>
  );
}

const dataEl = document.getElementById('poll-data');
const mount = document.getElementById('grid-root');
if (dataEl?.textContent && mount) {
  createRoot(mount).render(<Grid data={JSON.parse(dataEl.textContent) as PollData} />);
}
