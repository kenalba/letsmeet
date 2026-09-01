import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';

/** The one module script that upgrades this form's dates and window fields in place. */
export const CREATE_FORM_SCRIPTS = ['/assets/createForm.js'];

/** What the edit page pre-fills the form with: the poll's own record, field by field. */
export interface PollFormDefaults {
  title: string;
  description?: string;
  dates: string[];
  windowStart: string;
  windowEnd: string;
  slotMinutes: number;
  timezone: string;
}

export interface PollFormProps {
  /** Where the form posts: `/polls` to create, `/p/:rkey/edit` to save. */
  action?: string;
  /** Present on the edit page; absent, the form renders empty for a new poll. */
  defaults?: PollFormDefaults;
  /**
   * True once anyone has answered: the days, window, slot length and timezone render
   * disabled (so they post nothing) and only title and description can change. The server
   * enforces the same rule on its own; this is the form telling the host up front.
   */
  frozen?: boolean;
  submitLabel?: string;
}

/**
 * The poll form, rendered at GET /new (create) and GET /p/:rkey/edit (save). One component
 * so the two can never drift apart — `form.create button[type=submit]` and every field
 * *name* here are frozen DOM contracts that `routes/polls.ts` parses straight off the
 * FormData.
 *
 * Progressive enhancement for the dates field:
 *  - server-side, the frozen `dates` text input is the real control, `required` and visible;
 *  - `#create-dates` ships hidden, and `islands/createForm.tsx` unhides it, mounts the
 *    calendar there, hides `.dates-fallback` and drops the input's `required` (a
 *    display:none required field blocks submit with an unfocusable validation bubble)
 *    while leaving the input itself in the DOM, because it is what actually submits.
 *
 * The two window fields work the same way: the native `<input type="time">` pair is the
 * no-JS control, and `#window-start-field` / `#window-end-field` are the mount points the
 * island unhides to put a segmented `TimeField` in their place (hiding the inputs and
 * dropping their `required` for the same reason). Those spans are `display: contents` so
 * the mounted field becomes a grid item of the label's own column, exactly where the input
 * was; they carry phrasing content only, so a <span> is legal markup for them.
 *
 * `slotMinutes` stays a **native** select: Radix's SelectContent renders empty server-side
 * and posts nothing without a hidden input, so a styled native select is what keeps the
 * form contract with zero JS.
 *
 * The edit page seeds every field through `defaultValue`, which is also what the island
 * reads (`input.value`) when it mounts, so the calendar and time fields open on the poll's
 * own values. A frozen edit page ships no island at all: the disabled native inputs are the
 * whole story there.
 */
export function CreatePollForm({
  action = '/polls', defaults, frozen = false, submitLabel = 'create poll',
}: PollFormProps = {}) {
  const selectClass =
    'border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-base ' +
    'shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring ' +
    'focus-visible:ring-ring/50 focus-visible:ring-[3px] md:text-sm dark:bg-input/30 ' +
    'disabled:cursor-not-allowed disabled:opacity-50';
  return (
    <form method="post" action={action} className="create grid gap-5">
      <div className="grid gap-2">
        <Label htmlFor="poll-title">title</Label>
        <Input
          id="poll-title"
          name="title"
          required
          placeholder="movie night"
          defaultValue={defaults?.title}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="poll-description">description</Label>
        <Input
          id="poll-description"
          name="description"
          placeholder="optional"
          defaultValue={defaults?.description}
        />
      </div>
      <div className="grid gap-3">
        <div id="create-dates" hidden className="grid gap-3" />
        <label className="dates-fallback">
          <span className="grid gap-2">
            <span className="text-sm leading-none font-medium">dates</span>
            <Input
              name="dates"
              required
              placeholder="2026-09-02,2026-09-03"
              defaultValue={defaults?.dates.join(',')}
              disabled={frozen}
            />
            {frozen ? null : (
              <span className="text-xs text-muted-foreground">
                comma-separated iso dates, or use the picker.
              </span>
            )}
          </span>
        </label>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="poll-window-start">window start</Label>
          <Input
            id="poll-window-start"
            type="time"
            name="windowStart"
            required
            defaultValue={defaults?.windowStart}
            disabled={frozen}
          />
          <span id="window-start-field" hidden className="contents" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="poll-window-end">window end</Label>
          <Input
            id="poll-window-end"
            type="time"
            name="windowEnd"
            required
            defaultValue={defaults?.windowEnd}
            disabled={frozen}
          />
          <span id="window-end-field" hidden className="contents" />
        </div>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="poll-slot-minutes">slot length</Label>
          <select
            id="poll-slot-minutes"
            name="slotMinutes"
            defaultValue={String(defaults?.slotMinutes ?? 30)}
            disabled={frozen}
            className={selectClass}
          >
            <option value="10">10 minutes</option>
            <option value="15">15 minutes</option>
            <option value="20">20 minutes</option>
            <option value="30">30 minutes</option>
            <option value="45">45 minutes</option>
            <option value="60">1 hour</option>
            <option value="90">1.5 hours</option>
            <option value="120">2 hours</option>
          </select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="poll-timezone">timezone</Label>
          {/* Server-rendered "UTC" on the create form; the island swaps in the viewer's zone
              if it is untouched. The edit form marks its value explicit so the poll's own
              zone is never swapped out from under the host. */}
          <Input
            id="poll-timezone"
            name="timezone"
            required
            defaultValue={defaults?.timezone ?? 'UTC'}
            data-explicit={defaults ? '1' : undefined}
            placeholder="America/New_York"
            disabled={frozen}
          />
        </div>
      </div>
      <div>
        <Button type="submit">{submitLabel}</Button>
      </div>
    </form>
  );
}
