import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Badge } from '../ui/badge.js';
import { Calendar, toISODate } from '../ui/calendar.js';
import { TimeField, formatTime, parseTime } from '../ui/time-field.js';

/**
 * A Date at local midnight for `YYYY-MM-DD`.
 *
 * The mirror of `toISODate`: both directions read/write LOCAL calendar parts, never
 * `toISOString()` / `new Date(iso)` (which parse a bare date as UTC and land on the
 * previous day for anyone west of Greenwich).
 */
function fromISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Only well-formed `YYYY-MM-DD` tokens survive: the fallback is a plain text input, so
 * anything a visitor typed before the island mounted (or pasted into it) could otherwise
 * seed the picker's state with junk that `fromISODate` turns into an Invalid Date.
 */
function parseDates(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
}

/** One native `<input type="time">` and the (hidden) span the TimeField mounts over it. */
interface WindowField {
  input: HTMLInputElement;
  mount: HTMLElement;
}

interface CreateFormProps {
  /** The frozen `dates` input. Still in the DOM, still what submits — we just write it. */
  input: HTMLInputElement;
  form: HTMLFormElement;
  /**
   * Null on coarse-pointer devices: segments have no virtual keyboard, so phones keep the
   * native time inputs (which open a platform picker) and only the calendar is enhanced.
   */
  start: WindowField | null;
  end: WindowField | null;
}

/**
 * The enhanced half of the create form: the calendar, the two segmented time fields, and the
 * one submit guard that covers them all.
 *
 * ONE root, mounted at `#create-dates`, with the time fields rendered through portals into
 * their own mount points. Three separate roots would each need their own copy of the guard
 * and their own `[role=alert]`, and a visitor who left two fields blank would get two
 * disconnected complaints; sharing state is what lets the guard say everything at once, in
 * the single alert that already existed for the dates.
 */
function CreateForm({ input, form, start, end }: CreateFormProps) {
  const [dates, setDates] = useState<Set<string>>(() => new Set(parseDates(input.value)));
  // Normalised through the same parse the field itself uses, so a value the browser or a
  // visitor left behind that the TimeField cannot show ("2pm") counts as unset here too.
  const [startTime, setStartTime] = useState(() => (start ? formatTime(parseTime(start.input.value)) : ''));
  const [endTime, setEndTime] = useState(() => (end ? formatTime(parseTime(end.input.value)) : ''));
  const [error, setError] = useState<string | null>(null);

  const sorted = useMemo(() => [...dates].sort(), [dates]);

  // The inputs are the source of truth for the POST, so they trail every change.
  useEffect(() => {
    input.value = sorted.join(',');
  }, [input, sorted]);
  useEffect(() => {
    if (start) start.input.value = startTime;
  }, [start, startTime]);
  useEffect(() => {
    if (end) end.input.value = endTime;
  }, [end, endTime]);

  useEffect(() => {
    const onSubmit = (e: Event) => {
      const problems: string[] = [];
      if (dates.size === 0) problems.push('pick at least one date.');
      // Without the segmented fields the native inputs keep `required`, which covers this.
      if (start && end && (!startTime || !endTime)) problems.push('pick a start and end time.');
      if (problems.length > 0) {
        e.preventDefault();
        setError(problems.join(' '));
      }
    };
    form.addEventListener('submit', onSubmit);
    return () => form.removeEventListener('submit', onSubmit);
  }, [form, dates, startTime, endTime, start, end]);

  const replace = useCallback((next: Iterable<string>) => {
    setDates(new Set(next));
    setError(null);
  }, []);

  const remove = useCallback(
    (iso: string) => setDates((prev) => {
      const next = new Set(prev);
      next.delete(iso);
      return next;
    }),
    [],
  );

  // Stable identities: `TimeField` emits through an effect keyed on this callback.
  const onStart = useCallback((v: string) => {
    setStartTime(v);
    setError(null);
  }, []);
  const onEnd = useCallback((v: string) => {
    setEndTime(v);
    setError(null);
  }, []);

  return (
    <div className="grid gap-3">
      <span className="text-sm leading-none font-medium">dates</span>
      <Calendar
        mode="multiple"
        selected={sorted.map(fromISODate)}
        onSelect={(days) => replace((days ?? []).map(toISODate))}
        className="rounded-md border p-2"
      />
      <div className="date-chips flex flex-wrap gap-2" aria-live="polite">
        {sorted.map((iso) => (
          <Badge key={iso} variant="secondary" className="gap-1 py-1 pr-1 pl-2">
            {iso}
            <button
              type="button"
              aria-label={`Remove ${iso}`}
              onClick={() => remove(iso)}
              className="rounded-sm px-1 leading-none hover:bg-background/60"
            >
              ×
            </button>
          </Badge>
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {start ? createPortal(
        <TimeField
          name={start.input.name}
          initial={startTime}
          onValue={onStart}
          pickerInput={start.input}
        />,
        start.mount,
      ) : null}
      {end ? createPortal(
        <TimeField
          name={end.input.name}
          initial={endTime}
          onValue={onEnd}
          pickerInput={end.input}
        />,
        end.mount,
      ) : null}
    </div>
  );
}

/**
 * Locate one native time input and the span the TimeField will mount over it. Pure lookup:
 * nothing is hidden until *every* piece of the enhancement is present, or a missing mount
 * point would leave a visitor with a hidden time input and nothing in its place.
 */
function findTimeInput(inputId: string, mountId: string): WindowField | null {
  const input = document.querySelector<HTMLInputElement>(`input#${inputId}`);
  const mount = document.getElementById(mountId);
  return input && mount ? { input, mount } : null;
}

/**
 * Hand one time input over to its TimeField: hide it (it stays in the DOM as the field that
 * submits), drop its `required` — a display:none required field blocks submit with an
 * unfocusable validation bubble, the same trap the dates input has — and unhide the mount.
 * The visible <label> loses its now-pointless `for` and instead focuses the hour segment,
 * so clicking "Window start" still lands in the field.
 */
function claimTimeInput({ input, mount }: WindowField): void {
  const labelId = input.id;
  // Visually hidden, NOT display:none: `showPicker()` needs a rendered input to anchor the
  // platform popup to, and this keeps it right under the segmented field it stands behind.
  input.style.position = 'absolute';
  input.style.opacity = '0';
  input.style.pointerEvents = 'none';
  input.style.width = '1px';
  input.style.height = '1px';
  input.tabIndex = -1;
  input.required = false;
  mount.hidden = false;
  const label = document.querySelector<HTMLLabelElement>(`label[for="${labelId}"]`);
  if (!label) return;
  label.style.position = 'relative'; // the 1px input anchors the popup inside this label
  label.removeAttribute('for');
  label.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document
      .querySelector<HTMLElement>(`[data-time-field="${input.name}"] [data-segment="hour"]`)
      ?.focus();
  });
}

const datesMount = document.getElementById('create-dates');
const fallback = document.querySelector<HTMLElement>('.dates-fallback');
const datesInput = document.querySelector<HTMLInputElement>('input[name="dates"]');
const form = datesInput?.closest('form');
// Segments need a hardware keyboard; a phone gets the platform's own time picker instead.
const wantSegmented = !window.matchMedia('(pointer: coarse)').matches;
const foundStart = wantSegmented ? findTimeInput('poll-window-start', 'window-start-field') : null;
const foundEnd = wantSegmented ? findTimeInput('poll-window-end', 'window-end-field') : null;
// All-or-nothing: one claimed input with the other's mount missing would be a half-dead form.
const start = foundStart && foundEnd ? foundStart : null;
const end = foundStart && foundEnd ? foundEnd : null;
if (datesMount && fallback && datesInput && form) {
  fallback.hidden = true; // the input stays in the DOM and still submits
  datesInput.required = false; // a display:none required input blocks submit unfocusably
  datesMount.hidden = false;
  if (start && end) {
    claimTimeInput(start);
    claimTimeInput(end);
  }
  createRoot(datesMount).render(
    <StrictMode>
      <CreateForm input={datesInput} form={form} start={start} end={end} />
    </StrictMode>,
  );
}

// Only the untouched server default is replaced: a zone the visitor typed is theirs, and
// so is one the edit form rendered from the poll itself (`data-explicit`).
const tz = document.querySelector<HTMLInputElement>('input[name="timezone"]');
if (tz && tz.value === 'UTC' && !tz.dataset.explicit) {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (local) tz.value = local;
}
