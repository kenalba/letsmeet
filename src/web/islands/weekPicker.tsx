import { useEffect, useRef, useState } from 'react';
import {
  addMonths, domOf, mondayOf, monthDayLabel, monthTitle, plusDays, weekOffsetOf,
} from '../../core/weekView.js';
import { cn } from '../lib/cn.js';

/** The columns' order, and the picker's header row. */
export const DOW_MON = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** Where the grid is pointed: the usual week, or a week offset from this Monday. */
export type Page = 'usual' | number;

/**
 * A small calendar whose rows are the choice: click a row to show that week. Weeks already
 * over are disabled, today is underlined, a day with away carries an orange dot, and the
 * usual week sits above the calendar. Escape or a click outside closes it.
 *
 * `onClose` is a dependency of the outside-click effect: pass a stable callback, or the
 * listeners re-arm — and the opening click's one-tick grace restarts — on every render of
 * whatever holds the picker open.
 */
export function WeekPicker({ page, today, thisMonday, hasAway, onPick, onClose }: {
  page: Page;
  today: string;
  thisMonday: string;
  hasAway: (date: string) => boolean;
  onPick: (p: Page) => void;
  onClose: () => void;
}) {
  const [month, setMonth] = useState(
    () => `${(page === 'usual' ? today : plusDays(thisMonday, page * 7)).slice(0, 8)}01`);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const click = (e: MouseEvent) => {
      if (e.target instanceof Node && !box.current?.contains(e.target)) onClose();
    };
    window.addEventListener('keydown', key);
    // A tick late: the click that opened the picker must not also close it.
    const t = window.setTimeout(() => window.addEventListener('click', click), 0);
    return () => {
      window.removeEventListener('keydown', key);
      window.clearTimeout(t);
      window.removeEventListener('click', click);
    };
  }, [onClose]);
  const weeks: string[] = [];
  const last = plusDays(addMonths(month, 1), -1);
  for (let m = mondayOf(month); m <= last; m = plusDays(m, 7)) weeks.push(m);
  return (
    <div className="weekpick" role="dialog" aria-label="pick a week" ref={box}>
      <button
        type="button"
        className={cn('usual', page === 'usual' && 'current')}
        onClick={() => onPick('usual')}
      >&gt; usual week</button>
      <div className="mh">
        <button type="button" aria-label="previous month" onClick={() => setMonth(addMonths(month, -1))}>‹</button>
        <span>{monthTitle(month)}</span>
        <button type="button" aria-label="next month" onClick={() => setMonth(addMonths(month, 1))}>›</button>
      </div>
      <div className="dows">{DOW_MON.map((d) => <span key={d}>{d.slice(0, 2)}</span>)}</div>
      {weeks.map((mon) => {
        const off = weekOffsetOf(mon, thisMonday);
        return (
          <button
            key={mon}
            type="button"
            className={cn('wk', off === page && 'current')}
            disabled={off < 0}
            aria-label={`week of ${monthDayLabel(mon)}`}
            onClick={() => onPick(off)}
          >
            {Array.from({ length: 7 }, (_, i) => plusDays(mon, i)).map((d) => (
              <span
                key={d}
                className={cn(
                  d.slice(0, 7) !== month.slice(0, 7) && 'out',
                  d === today && 'today',
                  hasAway(d) && 'away',
                )}
              >{domOf(d)}</span>
            ))}
          </button>
        );
      })}
      <div className="foot">a row is a week. dots are away days.</div>
    </div>
  );
}
