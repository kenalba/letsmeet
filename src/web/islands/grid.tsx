import type { PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  buildGeom, strokeOp, rectKeys, applyPaint, paintToIntervals, intervalsToPaint,
  type PaintMap, type PaintMode,
} from '../../core/gridModel.js';
import type { Interval } from '../../core/intervals.js';
import { cn } from '../lib/cn.js';
// Only the class-string generator, never the <Button> component: <Button> stamps
// data-slot="button", which would land inside #grid-root and start matching the same
// `[data-slot]` selector the e2e grid-cell locator uses to find painted cells.
import { buttonVariants } from '../ui/button.js';

/** Names, per slot, of who can make it — mirrors the server's `RankedSlot`. */
interface SlotCount {
  available: string[];
  ifNeedBe: string[];
}

interface PollData {
  rkey: string;
  slots: Interval[];
  /** The poll's home zone. The grid opens in the viewer's zone and can toggle to this one. */
  timezone: string;
  viewerDid: string | null;
  editToken?: string;
  prefill?: { available: Interval[]; ifNeedBe: Interval[]; name?: string };
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
 * `d` is already a calendar date *in `zone`* (buildGeom bucketed it there) — its weekday is
 * fixed regardless of viewing zone, so anchoring at noon UTC and formatting in UTC reads back
 * that same date `d` for any `zone`: no zone-aware math needed, unlike `fmtTime` below.
 */
function fmtDate(d: string, zone: string): string {
  return new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

/**
 * How many people have answered, for the heatmap denominator: the distinct names appearing
 * anywhere in `counts`. The server only ships per-slot name lists, so someone who responded
 * without painting a single slot is invisible here and is not counted — they also tint no
 * cell, so the ratio stays within [0,1] and the darkest cell still means "everyone we can
 * see said yes". Duplicate display names collapse into one responder.
 */
function countResponders(counts: Record<string, SlotCount> | undefined): number {
  const names = new Set<string>();
  for (const c of Object.values(counts ?? {})) {
    for (const n of c.available) names.add(n);
    for (const n of c.ifNeedBe) names.add(n);
  }
  return names.size;
}

/**
 * One grid, not two. Every cell is tinted by how many people can make that slot (the old
 * read-only "Group" view), and the viewer's own paint sits on top of that tint as a
 * shape — solid green for available, hatched for if-need-be, both ringed in the page
 * background so they read as *yours* against a similarly-dark heatmap tint. The per-cell
 * tally and the hover title carry the group detail that the overlay covers up.
 */
function Grid({ data }: { data: PollData }) {
  const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone || data.timezone;
  const [zone, setZone] = useState(viewerZone);
  const [mode, setMode] = useState<PaintMode>('available');
  const [name, setName] = useState(data.prefill?.name ?? '');
  const [status, setStatus] = useState<string | null>(null);
  const [editLink, setEditLink] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [painted, setPainted] = useState<PaintMap>(() =>
    data.prefill
      ? intervalsToPaint(data.prefill.available, data.prefill.ifNeedBe, data.slots)
      : new Map());

  // Columns are bucketed by calendar date *in the displayed zone*, so the whole geometry —
  // not just the labels — is rebuilt when the zone toggles.
  const geom = useMemo(() => buildGeom(data.slots, zone), [zone]);
  const slotByKey = useMemo(() => new Map(data.slots.map((s) => [s.start, s])), []);
  const responders = useMemo(() => countResponders(data.counts), []);
  const locked = data.readonly === true;

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
    // Cells now contain spans (the time label and the tally), so the topmost element under
    // the pointer is usually one of those — climb to the cell that owns it.
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
        setStatus(out.error ?? 'Something went wrong.');
        setSaving(false);
        return;
      }
      setStatus(out.pending
        ? 'Saved — syncing to the host’s account in the background.'
        : 'Saved!');
      // A token the guest does not already hold is the one thing on this page they cannot get
      // back: show it and let them reload on their own terms. Every other path (signed-in
      // submits, and edits made through a link they already have) reloads on a short timer.
      // `saving` deliberately stays true afterwards — re-saving without an edit token would
      // file a second, separate response rather than update this one.
      const fresh = out.editToken && out.editToken !== data.editToken ? out.editToken : null;
      if (fresh) setEditLink(`${location.origin}/p/${data.rkey}/e/${fresh}`);
      else setTimeout(() => location.reload(), 1200);
    } catch {
      setStatus('Could not reach the server — try again.');
      setSaving(false);
    }
  };

  const canSwitchZone = viewerZone !== data.timezone;

  const cell = (key: string) => {
    const end = slotByKey.get(key)!.end;
    const range = `${fmtTime(key, zone)}–${fmtTime(end, zone)}`;
    const c = data.counts?.[key] ?? NO_COUNT;
    const mine = painted.get(key);
    const ratio = responders > 0 ? c.available.length / responders : 0;
    const tally = c.available.length + c.ifNeedBe.length;
    const title = responders === 0 ? range : [
      range,
      `Available (${c.available.length}/${responders}): ${c.available.join(', ') || 'nobody yet'}`,
      c.ifNeedBe.length ? `If need be: ${c.ifNeedBe.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    return (
      <div
        key={key}
        data-slot={key}
        className={cn('cell', mine)}
        // The heatmap tint is the cell's *base*, so it is skipped where the viewer's own
        // paint covers it: an inline background would otherwise beat `.cell.available`'s
        // solid green, and that green has to stay dominant.
        // Text color stays inherited (--card-foreground): it flips with the theme, and it
        // clears contrast on the tint at every ratio in both palettes — a hardcoded white
        // did not.
        style={!mine && ratio > 0
          ? { background: `rgba(43,138,95,${(0.15 + 0.85 * ratio).toFixed(3)})` }
          : undefined}
        onPointerDown={locked ? undefined : onDown(key)}
        title={title}
      >
        <span className="at">{fmtTime(key, zone)}</span>
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
        <div className="modes" role="group" aria-label="Paint mode">
          <button
            type="button"
            className={cn(
              buttonVariants({ variant: mode === 'available' ? 'default' : 'outline', size: 'sm' }),
              mode === 'available' ? 'mode active' : 'mode',
            )}
            aria-pressed={mode === 'available'}
            disabled={locked}
            onClick={() => setMode('available')}
          >Available</button>
          <button
            type="button"
            className={cn(
              buttonVariants({ variant: mode === 'ifNeedBe' ? 'default' : 'outline', size: 'sm' }),
              mode === 'ifNeedBe' ? 'mode active' : 'mode',
            )}
            aria-pressed={mode === 'ifNeedBe'}
            disabled={locked}
            onClick={() => setMode('ifNeedBe')}
          >If need be</button>
        </div>
        <button
          type="button"
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'zone')}
          disabled={!canSwitchZone}
          title={canSwitchZone
            ? `Switch between your timezone (${viewerZone}) and the poll's (${data.timezone})`
            : "Your timezone matches the poll's"}
          onClick={() => setZone(zone === viewerZone ? data.timezone : viewerZone)}
        >Times shown in {zone}{canSwitchZone ? ' — switch' : ''}</button>
      </div>
      <div
        // `counted` only widens the cells, and only once there is a tally to fit: an
        // unanswered poll keeps the narrow columns that fit a phone without scrolling.
        className={cn('grid', responders > 0 && 'counted', locked && 'readonly')}
        style={{ touchAction: 'none' }}
        onPointerMove={onMove}
      >
        {geom.dates.map((d) => (
          <div className="col" key={d}>
            <div className="col-head">{fmtDate(d, zone)}</div>
            {geom.columns.get(d)!.map((key) => cell(key))}
          </div>
        ))}
      </div>
      {responders > 0 && (
        <p className="hint">
          {`Shading counts how many of the ${responders} `
            + `${responders === 1 ? 'response' : 'responses'} can make each slot`}
          {locked ? '.' : '; your own cells are outlined.'}
        </p>
      )}
      {!data.viewerDid && !locked && (
        <label className="name">
          Your name <small>(shown publicly on this poll)</small>
          {/* React's onChange is Preact's onInput: it fires on every keystroke. */}
          <input value={name} onChange={(e) => setName(e.currentTarget.value)} />
        </label>
      )}
      {!locked && (
        <button
          className={cn(buttonVariants({ variant: 'default' }), 'save')}
          type="button"
          onClick={submit}
          disabled={saving || (!data.viewerDid && !name.trim())}
        >Save availability</button>
      )}
      {status && <p className="status" role="status">{status}</p>}
      {editLink && (
        <p className="edit-link">Keep this link to edit your response later:<br /><code>{editLink}</code></p>
      )}
      {editLink && (
        <button
          type="button"
          className={cn(buttonVariants({ variant: 'secondary' }), 'show-results secondary')}
          onClick={() => location.reload()}
        >Show results</button>
      )}
    </div>
  );
}

const dataEl = document.getElementById('poll-data');
const mount = document.getElementById('grid-root');
if (dataEl?.textContent && mount) {
  createRoot(mount).render(<Grid data={JSON.parse(dataEl.textContent) as PollData} />);
}
