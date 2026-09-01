import * as React from 'react';

import { cn } from '../lib/cn.js';

/**
 * A segmented 12-hour time field — hour / minute / AM-PM — in the shadcn idiom, modelled on
 * the interaction of huybuidac/shadcn-datetime-picker's DateTimeInput but written fresh,
 * time-only, with no date library.
 *
 * CLIENT-ONLY: this is never server-rendered. The pages ship the frozen native
 * `<input type="time">` (the field that actually submits, and the no-JS control);
 * `islands/createForm.tsx` hides that input and mounts this over it, writing 24h `"HH:mm"`
 * back through `onValue`. Nothing here touches `document` at module scope, so the pure
 * conversions below can still be imported (and unit-tested) from Node.
 */

/** 12-hour clock parts. `null` means "that segment is still empty", not zero. */
export interface TimeParts {
  /** 1–12, or null. */
  hour: number | null;
  /** 0–59, or null. */
  minute: number | null;
  period: 'AM' | 'PM' | null;
}

export const EMPTY_TIME: TimeParts = { hour: null, minute: null, period: null };

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * `"HH:mm"` (24h) -> 12-hour parts. Anything that is not a real time of day — the empty
 * string, junk a visitor pasted into the fallback input, "24:00" — parses as empty rather
 * than throwing, so a bad value can only ever cost the visitor a re-entry.
 */
export function parseTime(value: string): TimeParts {
  const m = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!m) return EMPTY_TIME;
  const h24 = Number(m[1]);
  const minute = Number(m[2]);
  if (h24 > 23 || minute > 59) return EMPTY_TIME;
  return { hour: h24 % 12 === 0 ? 12 : h24 % 12, minute, period: h24 < 12 ? 'AM' : 'PM' };
}

/**
 * 12-hour parts -> `"HH:mm"` (24h), or `""` while any segment is still empty — a partial
 * time has no 24h spelling, and the empty string is exactly what the submitted input should
 * carry so the submit guard can see it is unset.
 *
 * The 12 o'clock hours are the whole subtlety: 12 AM is 00, 12 PM is 12.
 */
export function formatTime({ hour, minute, period }: TimeParts): string {
  if (hour === null || minute === null || period === null) return '';
  const h24 = period === 'AM' ? hour % 12 : (hour % 12) + 12;
  return `${pad2(h24)}:${pad2(minute)}`;
}

type Segment = 'hour' | 'minute' | 'period';

const SEGMENTS: readonly Segment[] = ['hour', 'minute', 'period'];

/** Arrows nudge minutes in fives; typed digits still set any minute exactly. */
const MINUTE_ARROW_STEP = 5;

/** How long a hour/minute segment waits for a second digit before moving on. */
const TYPING_WINDOW_MS = 1000;

export interface TimeFieldProps {
  /** The name of the native input this field stands in for; lands on `data-time-field`. */
  name: string;
  /** `"HH:mm"` (24h) or `""` — normally the hidden input's current value. */
  initial: string;
  /** Called with `"HH:mm"` once all three segments are set, and `""` whenever they aren't. */
  onValue: (value: string) => void;
}

export function TimeField({ name, initial, onValue }: TimeFieldProps) {
  const [parts, setParts] = React.useState<TimeParts>(() => parseTime(initial));
  const refs = React.useRef<Record<Segment, HTMLSpanElement | null>>({
    hour: null, minute: null, period: null,
  });

  // The digits typed so far into one segment, and the timer that gives up waiting for a
  // second one. Refs, not state: they steer the *next* keystroke and must be current the
  // instant it arrives, and nothing about them is rendered.
  const typed = React.useRef<{ segment: Segment; digits: string } | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTyping = React.useCallback(() => {
    typed.current = null;
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  React.useEffect(() => clearTyping, [clearTyping]);

  // The hidden input trails every change, so it is always what the form would post.
  React.useEffect(() => {
    onValue(formatTime(parts));
  }, [parts, onValue]);

  const focusSegment = React.useCallback((segment: Segment) => {
    refs.current[segment]?.focus();
  }, []);

  /**
   * Move on to the next segment — but only from a segment that still holds focus, so a
   * pending-digit timeout can never yank focus back from wherever the visitor went.
   */
  const advance = React.useCallback((from: Segment) => {
    const next = SEGMENTS[SEGMENTS.indexOf(from) + 1];
    if (next && refs.current[from] === document.activeElement) focusSegment(next);
  }, [focusSegment]);

  /** Hold `digits` open for one more keystroke; on timeout, take what we have and move on. */
  const waitForMore = React.useCallback((segment: Segment, digits: string) => {
    clearTyping();
    typed.current = { segment, digits };
    timer.current = setTimeout(() => {
      clearTyping();
      advance(segment);
    }, TYPING_WINDOW_MS);
  }, [advance, clearTyping]);

  const typeDigit = React.useCallback((segment: Segment, key: string) => {
    const carried = typed.current?.segment === segment ? typed.current.digits : '';
    const n = Number(key);

    if (segment === 'hour') {
      // A carried digit only survives if the pair is a real hour ("1" + "2" = 12); "1" + "3"
      // is not, so the 3 restarts as a first digit — the same forgiveness a native picker has.
      const pair = Number(carried + key);
      if (carried !== '' && pair >= 1 && pair <= 12) {
        setParts((p) => ({ ...p, hour: pair }));
        clearTyping();
        advance(segment);
        return;
      }
      if (n === 0) {
        // Not an hour on its own, but "0" then "9" is; keep the field empty and wait.
        setParts((p) => ({ ...p, hour: null }));
        waitForMore(segment, '0');
        return;
      }
      setParts((p) => ({ ...p, hour: n }));
      // Only 1 can still grow (10/11/12); 2–9 can't, so they commit immediately.
      if (n > 1) {
        clearTyping();
        advance(segment);
      } else {
        waitForMore(segment, key);
      }
      return;
    }

    if (segment === 'minute') {
      if (carried !== '') {
        // Only 0–5 are ever carried, so the pair is always ≤ 59.
        setParts((p) => ({ ...p, minute: Number(carried + key) }));
        clearTyping();
        advance(segment);
        return;
      }
      setParts((p) => ({ ...p, minute: n }));
      if (n > 5) {
        clearTyping();
        advance(segment);
      } else {
        waitForMore(segment, key);
      }
    }
    // Digits mean nothing to AM/PM — `a`/`p` set it, from any segment.
  }, [advance, clearTyping, waitForMore]);

  const step = React.useCallback((segment: Segment, delta: number) => {
    setParts((p) => {
      if (segment === 'hour') {
        const hour = p.hour === null
          ? (delta > 0 ? 1 : 12)
          : ((p.hour - 1 + delta + 12) % 12) + 1;
        return { ...p, hour };
      }
      if (segment === 'minute') {
        const minute = p.minute === null
          ? (delta > 0 ? 0 : 60 - MINUTE_ARROW_STEP)
          : (p.minute + delta * MINUTE_ARROW_STEP + 60) % 60;
        return { ...p, minute };
      }
      return { ...p, period: p.period === 'AM' ? 'PM' : 'AM' };
    });
  }, []);

  const onKeyDown = (segment: Segment) => (e: React.KeyboardEvent<HTMLSpanElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const key = e.key;

    if (key === 'a' || key === 'A' || key === 'p' || key === 'P') {
      e.preventDefault();
      const period = key.toLowerCase() === 'a' ? 'AM' : 'PM';
      setParts((p) => ({ ...p, period }));
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      e.preventDefault();
      clearTyping();
      const i = SEGMENTS.indexOf(segment) + (key === 'ArrowRight' ? 1 : -1);
      focusSegment(SEGMENTS[Math.min(SEGMENTS.length - 1, Math.max(0, i))]!);
      return;
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      e.preventDefault(); // or the page scrolls under the field
      clearTyping();
      step(segment, key === 'ArrowUp' ? 1 : -1);
      return;
    }
    if (key === 'Backspace' || key === 'Delete') {
      e.preventDefault();
      clearTyping();
      setParts((p) => ({ ...p, [segment]: null }));
      return;
    }
    if (/^\d$/.test(key)) {
      e.preventDefault();
      typeDigit(segment, key);
    }
  };

  function renderSegment(
    segment: Segment,
    { label, min, max, value, text }:
      { label: string; min: number; max: number; value: number | null; text: string | null },
  ) {
    return (
      <span
        ref={(el) => { refs.current[segment] = el; }}
        role="spinbutton"
        data-segment={segment}
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value ?? undefined}
        aria-valuetext={text ?? 'empty'}
        onKeyDown={onKeyDown(segment)}
        onFocus={() => { if (typed.current?.segment !== segment) clearTyping(); }}
        className={cn(
          'rounded-sm px-0.5 tabular-nums outline-none',
          'focus:bg-accent focus:text-accent-foreground',
          text === null && 'text-muted-foreground',
        )}
      >
        {text ?? '--'}
      </span>
    );
  }

  return (
    <span
      data-time-field={name}
      onMouseDown={(e) => {
        // Clicking the padding (or a separator) lands on the hour, as a native field does.
        if (e.target === e.currentTarget || !(e.target as HTMLElement).dataset.segment) {
          e.preventDefault();
          focusSegment('hour');
        }
      }}
      className={cn(
        // Mirrors ui/input.tsx so this sits seamlessly beside a real Input, with the ring
        // moved to focus-within: the focusable elements are the segments inside.
        'border-input flex h-9 w-full min-w-0 items-center gap-0.5 rounded-md border',
        'bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow]',
        'outline-none select-none md:text-sm dark:bg-input/30',
        'focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]',
      )}
    >
      {renderSegment('hour', {
        label: 'Hour', min: 1, max: 12,
        value: parts.hour, text: parts.hour === null ? null : pad2(parts.hour),
      })}
      <span aria-hidden="true" className="text-muted-foreground">:</span>
      {renderSegment('minute', {
        label: 'Minute', min: 0, max: 59,
        value: parts.minute, text: parts.minute === null ? null : pad2(parts.minute),
      })}
      <span aria-hidden="true"> </span>
      {renderSegment('period', {
        label: 'AM/PM', min: 1, max: 2,
        value: parts.period === null ? null : (parts.period === 'AM' ? 1 : 2),
        text: parts.period,
      })}
    </span>
  );
}
