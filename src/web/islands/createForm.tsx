import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Badge } from '../ui/badge.js';
import { Calendar, toISODate } from '../ui/calendar.js';

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

function parseDates(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

interface DatesPickerProps {
  /** The frozen `dates` input. Still in the DOM, still what submits — we just write it. */
  input: HTMLInputElement;
  form: HTMLFormElement;
}

function DatesPicker({ input, form }: DatesPickerProps) {
  const [dates, setDates] = useState<Set<string>>(() => new Set(parseDates(input.value)));
  const [error, setError] = useState<string | null>(null);

  const sorted = useMemo(() => [...dates].sort(), [dates]);

  // The input is the source of truth for the POST, so it trails every change to the set.
  useEffect(() => {
    input.value = sorted.join(',');
  }, [input, sorted]);

  useEffect(() => {
    const onSubmit = (e: Event) => {
      if (dates.size === 0) {
        e.preventDefault();
        setError('Pick at least one date.');
      }
    };
    form.addEventListener('submit', onSubmit);
    return () => form.removeEventListener('submit', onSubmit);
  }, [form, dates]);

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

  return (
    <div className="grid gap-3">
      <span className="text-sm leading-none font-medium">Dates</span>
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
    </div>
  );
}

const mount = document.getElementById('create-dates');
const fallback = document.querySelector<HTMLElement>('.dates-fallback');
const datesInput = document.querySelector<HTMLInputElement>('input[name="dates"]');
const form = datesInput?.closest('form');
if (mount && fallback && datesInput && form) {
  fallback.hidden = true; // the input stays in the DOM and still submits
  datesInput.required = false; // a display:none required input blocks submit unfocusably
  mount.hidden = false;
  createRoot(mount).render(
    <StrictMode>
      <DatesPicker input={datesInput} form={form} />
    </StrictMode>,
  );
}

// Only the untouched server default is replaced: a zone the visitor typed is theirs.
const tz = document.querySelector<HTMLInputElement>('input[name="timezone"]');
if (tz && tz.value === 'UTC') {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (local) tz.value = local;
}
