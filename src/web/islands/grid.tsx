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
import { attachHandleTypeahead } from './handleTypeahead.js';

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

/** How long a finger rests on a cell before it paints instead of scrolling. Under the
 * browsers' own long-press (~500ms), so no callout or context menu races it. */
const HOLD_MS = 350;

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
  const [editLink, setEditLink] = useState<{ url: string; remembered: boolean } | null>(null);
  // One responder's saved answer, lit up on the grid: hovering their chip below the grid
  // does it in passing, tapping or clicking pins it (there is no hover on a phone).
  const [spotlight, setSpotlight] = useState<{ who: string; pinned: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  // What the server already has for this viewer; the save button lights up only when the
  // grid (or a guest's name) differs from it.
  const saved = useMemo<PaintMap>(() =>
    data.prefill
      ? intervalsToPaint(data.prefill.available, data.prefill.ifNeedBe, data.slots)
      : new Map(), []);
  // Paint stashed on the way to sign-in (the bluesky side of the identity toggle, or the
  // header link) comes back here, signed in or not, over whatever the server had; it is
  // cleared once read. What happens to it next is decided after `submit` is defined.
  const draft = useMemo(() => takeDraft(data.rkey, data.slots), []);
  const [painted, setPainted] = useState<PaintMap>(draft?.paint ?? saved);
  // A guest answers under a name, or signs in right here; the field swaps with the toggle
  // and both values survive switching back and forth.
  const [identity, setIdentity] = useState<'guest' | 'bluesky'>('guest');
  const [handle, setHandle] = useState('');
  const handleInput = useRef<HTMLInputElement>(null);
  const handleList = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (identity !== 'bluesky' || !handleInput.current || !handleList.current) return;
    return attachHandleTypeahead(handleInput.current, handleList.current);
  }, [identity]);

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

  const drag = useRef<{ anchor: string; op: 'add' | 'remove'; base: PaintMap; touch: boolean } | null>(null);
  // A finger resting on a cell that is not yet a stroke. It becomes one if it holds for
  // HOLD_MS, a tap if it lifts first, and nothing if the browser turns its movement into a
  // scroll (pointercancel). A mouse never waits: it can't scroll by dragging anyway.
  const press = useRef<{ key: string; timer: number } | null>(null);
  const gridEl = useRef<HTMLDivElement>(null);

  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };

  // The chips are server-rendered outside this island; listen to them from here.
  useEffect(() => {
    const chips = Array.from(document.querySelectorAll<HTMLElement>('.responders .chip[data-who]'));
    const offs = chips.flatMap((chip) => {
      const who = chip.dataset.who!;
      const enter = () => setSpotlight((cur) => cur?.pinned ? cur : { who, pinned: false });
      const leave = () => setSpotlight((cur) => cur?.pinned ? cur : null);
      const toggle = (e: Event) => {
        // The account chip's link still goes to the profile; the brackets around it pin.
        if (e.target instanceof HTMLAnchorElement) return;
        setSpotlight((cur) => cur?.pinned && cur.who === who ? null : { who, pinned: true });
      };
      chip.addEventListener('mouseenter', enter);
      chip.addEventListener('mouseleave', leave);
      chip.addEventListener('focusin', enter);
      chip.addEventListener('focusout', leave);
      chip.addEventListener('click', toggle);
      return [() => {
        chip.removeEventListener('mouseenter', enter);
        chip.removeEventListener('mouseleave', leave);
        chip.removeEventListener('focusin', enter);
        chip.removeEventListener('focusout', leave);
        chip.removeEventListener('click', toggle);
      }];
    });
    return () => offs.forEach((off) => off());
  }, []);
  useEffect(() => {
    document.querySelectorAll<HTMLElement>('.responders .chip[data-who]').forEach((chip) => {
      chip.classList.toggle('lit', chip.dataset.who === spotlight?.who);
      chip.classList.toggle('pinned', !!spotlight?.pinned && chip.dataset.who === spotlight.who);
    });
  }, [spotlight]);

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

  // The grid scrolls sideways on a phone, so the browser keeps touch gestures
  // (`touch-action: manipulation`) and only a held finger paints. Once it does, its movement
  // must not become a scroll: `touch-action` can't change mid-gesture and React's touch
  // handlers are passive, so this is a native, cancelling listener.
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
    setPainted(applyPaint(d.base, rectKeys(geom, d.anchor, key), d.op, mode));
  };

  const startStroke = (key: string, touch: boolean) => {
    drag.current = { anchor: key, op: strokeOp(painted, key, mode), base: painted, touch };
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
          // A nudge to say "you're painting now", where the device has one.
          try { navigator.vibrate?.(8); } catch { /* not this device */ }
        }, HOLD_MS),
      };
      return;
    }
    e.preventDefault();
    // Capture keeps the move stream coming even when the pointer wanders off the cell;
    // hit-testing below still uses the real element under the pointer.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported id */ }
    startStroke(key, false);
  };

  // A finger that lifts before the hold fires is a tap: paint (or unpaint) that one cell.
  // Runs before the window listener above clears the stroke it starts.
  const onUp = (key: string) => () => {
    if (press.current?.key !== key) return;
    cancelPress();
    startStroke(key, true);
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
      if (fresh) {
        const remembered = writeEditSecret(data.rkey, fresh);
        // The address bar now carries the edit link, so history, autocomplete and any
        // bookmark keep it too, and "show results" reloads into it.
        history.replaceState(null, '', editPath(data.rkey, fresh));
        setEditLink({ url: `${location.origin}${editPath(data.rkey, fresh)}`, remembered });
      } else setTimeout(() => location.reload(), 1200);
    } catch {
      setStatus('couldn’t reach the server. try again?');
      setSaving(false);
    }
  };

  // "sign in & save" asked for the save: finish it now that the sign-in is back. Paint
  // that came back any other way (the header link, a cancelled sign-in) waits to be saved.
  useEffect(() => {
    if (!draft) return;
    if (draft.save && data.viewerDid) void submit();
    else setStatus('your paint from before signing in is back. save it when you\u2019re ready.');
  }, []);

  const canSwitchZone = viewerZone !== data.timezone;

  const cell = (key: string, ci: number, ri: number) => {
    const end = slotByKey.get(key)!.end;
    const range = `${fmtTime(key, zone)}–${fmtTime(end, zone)}`;
    const mine = painted.get(key);
    // Everyone else's saved answer plus the viewer's current paint, so the numbers keep up
    // with the brush: "with you, 3 of 4 can make this".
    const c = liveTally(data.counts?.[key] ?? NO_COUNT, data.self, mine);
    // The spotlight follows saved answers (what the chips list), not the live repaint.
    const saved = data.counts?.[key] ?? NO_COUNT;
    const lit = spotlight
      ? saved.available.includes(spotlight.who) ? 'lit'
        : saved.ifNeedBe.includes(spotlight.who) ? 'lit-soft' : null
      : null;
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
        className={cn('cell', mine, lit)}
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
        onPointerUp={locked ? undefined : onUp(key)}
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
          {/* Prompt text with the brush colour underlined, like the identity toggle below:
              green under available, amber under if need be, so the line says which paint
              you are holding. */}
          <span className="hint">paint</span>
          {([['available', 'available'], ['ifNeedBe', 'if need be']] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={cn('prompt pixel-label toggle', id)}
              aria-pressed={mode === id}
              disabled={locked}
              onClick={() => setMode(id)}
            >{label}</button>
          ))}
        </div>
        {/* Only when there is something to switch: a viewer in the poll's own zone needs no
            telling, and the page's hint names the zone the list below is in. */}
        {canSwitchZone && (
          <button
            type="button"
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'zone')}
            title={`switch between your timezone (${viewerZone}) and the poll's (${data.timezone})`}
            onClick={() => setZone(zone === viewerZone ? data.timezone : viewerZone)}
          >times shown in {zone} · switch</button>
        )}
      </div>
      {/* Above the grid, which is taller than a phone screen: read before the first touch. */}
      {!locked && (
        <p className="hint touch-hint">tap a slot to paint it. hold, then drag, for a block. swipe to scroll.</p>
      )}
      <div
        ref={gridEl}
        className={cn('grid', locked && 'readonly', spotlight && 'spotlight')}
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
        <div className="whoami">
          {/* Two equal ways to answer, at the one place a guest says who they are. The
              header link and a note above the grid were both too easy to scroll past. */}
          <div className="modes" role="group" aria-label="answering as">
            <span className="hint">answering as</span>
            {/* Prompt text, not ring buttons: this sits in a line of prose. The selected
                one is ink with a green underline, the other grey — a two-tab tab bar. */}
            {(['guest', 'bluesky'] as const).map((id) => (
              <button
                key={id}
                type="button"
                className="prompt pixel-label toggle"
                aria-pressed={identity === id}
                onClick={() => setIdentity(id)}
              >{id}</button>
            ))}
          </div>
          {identity === 'guest' ? (
            <label className="name">
              your name <span className="note">(shown on this poll)</span>
              {/* React's onChange is Preact's onInput: it fires on every keystroke. */}
              <input value={name} onChange={(e) => setName(e.currentTarget.value)} />
            </label>
          ) : (
            /* The sign-in page's form, inline: same route, same typeahead. The paint goes
               along for the tab (sessionStorage) with a note to save it on return. */
            <form
              method="post"
              action="/login"
              className="handle"
              onSubmit={() => stashDraft(
                data.rkey,
                paintToIntervals(painted, data.slots, 'available'),
                paintToIntervals(painted, data.slots, 'ifNeedBe'),
                true,
              )}
            >
              <input type="hidden" name="returnTo" value={`/p/${data.rkey}`} />
              <label className="name" htmlFor="handle">your bluesky handle</label>
              <div className="relative">
                <input
                  ref={handleInput}
                  id="handle"
                  name="handle"
                  placeholder="you.bsky.social"
                  autoComplete="username"
                  spellCheck={false}
                  autoCapitalize="none"
                  required
                  defaultValue={handle}
                  onInput={(e) => setHandle(e.currentTarget.value)}
                />
                <ul ref={handleList} id="handle-suggestions" hidden />
              </div>
              <button type="submit" className={cn(buttonVariants({ variant: 'default' }), 'save')}>
                sign in &amp; save
              </button>
            </form>
          )}
        </div>
      )}
      {!locked && (data.viewerDid || identity === 'guest') && (
        <button
          className={cn(buttonVariants({ variant: 'default' }), 'save')}
          type="button"
          onClick={submit}
          disabled={saving || !canSave}
        >save availability</button>
      )}
      {status && <p className="status" role="status">{status}</p>}
      {editLink && (
        <p className="edit-link">
          {editLink.remembered
            ? 'this browser will remember your response. on another device, use this link to edit it:'
            : 'keep this link to edit your response later:'}
          <br /><code>{editLink.url}</code>
        </p>
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

/**
 * A guest's edit secret, kept on this device so the plain share link brings them back to
 * their own response: nobody keeps the link. Storage that is off or full just means the
 * link is the only way back, as before.
 */
const editKey = (rkey: string) => `letsmeet.edit.${rkey}`;
const editPath = (rkey: string, token: string) => `/p/${rkey}/e/${token}`;
function readEditSecret(rkey: string): string | null {
  try { return localStorage.getItem(editKey(rkey)); } catch { return null; }
}
/** True when the secret is now stored (or cleared); false when this browser won't keep it. */
function writeEditSecret(rkey: string, token: string | null): boolean {
  try {
    if (token) localStorage.setItem(editKey(rkey), token);
    else localStorage.removeItem(editKey(rkey));
    return true;
  } catch { return false; }
}

/**
 * Unsaved paint carried across the sign-in round trip: same tab, gone once read. `save`
 * records that "sign in & save" was pressed, so the return trip finishes the save.
 */
const draftKey = (rkey: string) => `letsmeet.draft.${rkey}`;
type Intervals = ReturnType<typeof paintToIntervals>;
function stashDraft(rkey: string, available: Intervals, ifNeedBe: Intervals, save = false): void {
  try {
    sessionStorage.setItem(draftKey(rkey), JSON.stringify({ available, ifNeedBe, save }));
  } catch { /* then it is lost, as before */ }
}
function takeDraft(rkey: string, slots: PollData['slots']): { paint: PaintMap; save: boolean } | null {
  try {
    const raw = sessionStorage.getItem(draftKey(rkey));
    if (!raw) return null;
    sessionStorage.removeItem(draftKey(rkey));
    const d = JSON.parse(raw) as { available?: Intervals; ifNeedBe?: Intervals; save?: boolean };
    return { paint: intervalsToPaint(d.available ?? [], d.ifNeedBe ?? [], slots), save: !!d.save };
  } catch { return null; }
}

const dataEl = document.getElementById('poll-data');
const mount = document.getElementById('grid-root');
if (dataEl?.textContent && mount) {
  const data = JSON.parse(dataEl.textContent) as PollData;
  const onEditUrl = /\/e\/[^/]+$/.test(location.pathname);
  // The plain share link, on a device that answered before, signed out: straight to that
  // response, without painting a blank grid first.
  const kept = data.editToken || data.viewerDid || onEditUrl ? null : readEditSecret(data.rkey);
  if (kept) {
    location.replace(editPath(data.rkey, kept));
  } else {
    if (data.editToken) {
      // Arrived by a working edit link (pasted, bookmarked, or sent here above): keep it.
      writeEditSecret(data.rkey, data.editToken);
    } else if (onEditUrl) {
      // An edit link that no longer resolves: forget it, and show the plain address.
      writeEditSecret(data.rkey, null);
      history.replaceState(null, '', `/p/${data.rkey}`);
    }
    createRoot(mount).render(<Grid data={data} />);
  }
}
