import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';

/** The one module script that upgrades this form's dates field into a calendar. */
export const CREATE_FORM_SCRIPTS = ['/assets/createForm.js'];

/**
 * The create form, rendered both on the signed-in landing page (where the e2e flow fills it)
 * and at GET /new. One component so the two can never drift apart — `form.create
 * button[type=submit]` and every field *name* here are frozen DOM contracts that
 * `routes/polls.ts` parses straight off the FormData.
 *
 * Progressive enhancement for the dates field:
 *  - server-side, the frozen `dates` text input is the real control, `required` and visible;
 *  - `#create-dates` ships hidden, and `islands/createForm.tsx` unhides it, mounts the
 *    calendar there, hides `.dates-fallback` and drops the input's `required` (a
 *    display:none required field blocks submit with an unfocusable validation bubble)
 *    while leaving the input itself in the DOM, because it is what actually submits.
 *
 * `slotMinutes` stays a **native** select: Radix's SelectContent renders empty server-side
 * and posts nothing without a hidden input, so a styled native select is what keeps the
 * form contract with zero JS.
 */
export function CreatePollForm() {
  const selectClass =
    'border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-base ' +
    'shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring ' +
    'focus-visible:ring-ring/50 focus-visible:ring-[3px] md:text-sm dark:bg-input/30';
  return (
    <form method="post" action="/polls" className="create grid gap-5">
      <div className="grid gap-2">
        <Label htmlFor="poll-title">Title</Label>
        <Input id="poll-title" name="title" required placeholder="Movie night" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="poll-description">Description</Label>
        <Input id="poll-description" name="description" placeholder="Optional" />
      </div>
      <div className="grid gap-3">
        <div id="create-dates" hidden className="grid gap-3" />
        <label className="dates-fallback">
          <span className="grid gap-2">
            <span className="text-sm leading-none font-medium">Dates</span>
            <Input name="dates" required placeholder="2026-09-02,2026-09-03" />
            <span className="text-xs text-muted-foreground">
              Comma-separated ISO dates — or use the picker.
            </span>
          </span>
        </label>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="poll-window-start">Window start</Label>
          <Input id="poll-window-start" type="time" name="windowStart" required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="poll-window-end">Window end</Label>
          <Input id="poll-window-end" type="time" name="windowEnd" required />
        </div>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="poll-slot-minutes">Slot length</Label>
          <select
            id="poll-slot-minutes"
            name="slotMinutes"
            defaultValue="30"
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
          <Label htmlFor="poll-timezone">Timezone</Label>
          {/* Server-rendered "UTC"; the island swaps in the viewer's zone if it is untouched. */}
          <Input
            id="poll-timezone"
            name="timezone"
            required
            defaultValue="UTC"
            placeholder="America/New_York"
          />
        </div>
      </div>
      <div>
        <Button type="submit">Create poll</Button>
      </div>
    </form>
  );
}
