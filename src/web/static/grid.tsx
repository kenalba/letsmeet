import { render } from 'preact';
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DateTime } from 'luxon';
import {
  buildGeom, strokeOp, rectKeys, applyPaint, paintToIntervals, intervalsToPaint,
  type PaintMap, type PaintMode,
} from '../../core/gridModel.js';
import type { Interval } from '../../core/intervals.js';

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
}

/** "me" paints your own answer; "group" is a read-only heatmap of everyone's. */
type View = 'me' | 'group';

const NO_COUNT: SlotCount = { available: [], ifNeedBe: [] };

function fmtTime(iso: string, zone: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', timeZone: zone,
  });
}

/**
 * `d` is already a calendar date *in `zone`* (buildGeom bucketed it there), so anchor it at
 * noon in that same zone before formatting: parsing "d T12:00" as machine-local and then
 * rendering it in a far-away zone can slide the label onto the neighbouring day.
 */
function fmtDate(d: string, zone: string): string {
  return DateTime.fromISO(`${d}T12:00`, { zone }).toJSDate().toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: zone,
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

function Grid({ data }: { data: PollData }) {
  const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone || data.timezone;
  const [zone, setZone] = useState(viewerZone);
  const [view, setView] = useState<View>('me');
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

  const onDown = (key: string) => (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    // Capture keeps the move stream coming even when the pointer wanders off the cell;
    // hit-testing below still uses the real element under the pointer.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported id */ }
    drag.current = { anchor: key, op: strokeOp(painted, key, mode), base: painted };
    paintTo(key);
  };

  const onMove = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const key = el instanceof HTMLElement ? el.dataset.slot : undefined;
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
      if (out.editToken) setEditLink(`${location.origin}/p/${data.rkey}/e/${out.editToken}`);
      setTimeout(() => location.reload(), out.editToken ? 4000 : 1200);
    } catch {
      setStatus('Could not reach the server — try again.');
      setSaving(false);
    }
  };

  const canSwitchZone = viewerZone !== data.timezone;
  const group = view === 'group';

  const cell = (key: string) => {
    const end = slotByKey.get(key)!.end;
    const range = `${fmtTime(key, zone)}–${fmtTime(end, zone)}`;
    if (!group) {
      return (
        <div
          key={key}
          data-slot={key}
          class={`cell ${painted.get(key) ?? ''}`}
          onPointerDown={onDown(key)}
          title={range}
        >{fmtTime(key, zone)}</div>
      );
    }
    const c = data.counts?.[key] ?? NO_COUNT;
    const ratio = responders > 0 ? c.available.length / responders : 0;
    const hatched = c.available.length === 0 && c.ifNeedBe.length > 0;
    const title = [
      range,
      `Available (${c.available.length}${responders ? `/${responders}` : ''}): ${c.available.join(', ') || 'nobody yet'}`,
      c.ifNeedBe.length ? `If need be: ${c.ifNeedBe.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    return (
      <div
        key={key}
        data-slot={key}
        class={`cell group${hatched ? ' hatch' : ''}`}
        style={ratio > 0
          ? {
            background: `rgba(43,138,95,${(0.15 + 0.85 * ratio).toFixed(3)})`,
            color: ratio > 0.55 ? '#fff' : undefined,
          }
          : undefined}
        title={title}
      >
        <span class="at">{fmtTime(key, zone)}</span>
        <span class="tally">
          {c.available.length}{c.ifNeedBe.length ? `+${c.ifNeedBe.length}` : ''}
        </span>
      </div>
    );
  };

  return (
    <div>
      <div class="toolbar">
        <div class="modes" role="group" aria-label="Paint mode">
          <button
            type="button"
            class={mode === 'available' ? 'mode active' : 'mode'}
            aria-pressed={mode === 'available'}
            disabled={group}
            onClick={() => setMode('available')}
          >Available</button>
          <button
            type="button"
            class={mode === 'ifNeedBe' ? 'mode active' : 'mode'}
            aria-pressed={mode === 'ifNeedBe'}
            disabled={group}
            onClick={() => setMode('ifNeedBe')}
          >If need be</button>
        </div>
        <div class="views" role="group" aria-label="Whose availability to show">
          <button
            type="button"
            class={group ? 'view' : 'view active'}
            aria-pressed={!group}
            onClick={() => setView('me')}
          >Me</button>
          <button
            type="button"
            class={group ? 'view active' : 'view'}
            aria-pressed={group}
            onClick={() => setView('group')}
          >Group</button>
        </div>
        <button
          type="button"
          class="zone"
          disabled={!canSwitchZone}
          title={canSwitchZone
            ? `Switch between your timezone (${viewerZone}) and the poll's (${data.timezone})`
            : "Your timezone matches the poll's"}
          onClick={() => setZone(zone === viewerZone ? data.timezone : viewerZone)}
        >Times shown in {zone}{canSwitchZone ? ' — switch' : ''}</button>
      </div>
      <div
        class={group ? 'grid readonly' : 'grid'}
        style={{ touchAction: 'none' }}
        onPointerMove={onMove}
      >
        {geom.dates.map((d) => (
          <div class="col" key={d}>
            <div class="col-head">{fmtDate(d, zone)}</div>
            {geom.columns.get(d)!.map(cell)}
          </div>
        ))}
      </div>
      {group && (
        <p class="hint">
          {responders > 0
            ? `Read-only view of ${responders} ${responders === 1 ? 'response' : 'responses'}. Switch to “Me” to paint your own.`
            : 'No responses yet. Switch to “Me” to paint your own.'}
        </p>
      )}
      {!data.viewerDid && (
        <label class="name">
          Your name <small>(shown publicly on this poll)</small>
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
      )}
      <button
        class="save"
        type="button"
        onClick={submit}
        disabled={saving || (!data.viewerDid && !name.trim())}
      >Save availability</button>
      {status && <p class="status" role="status">{status}</p>}
      {editLink && (
        <p class="edit-link">Keep this link to edit your response later:<br /><code>{editLink}</code></p>
      )}
    </div>
  );
}

const dataEl = document.getElementById('poll-data');
const mount = document.getElementById('grid-root');
if (dataEl?.textContent && mount) {
  render(<Grid data={JSON.parse(dataEl.textContent) as PollData} />, mount);
}
