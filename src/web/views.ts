import { DateTime } from 'luxon';
import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { Interval } from '../core/intervals.js';
import type { SpecificDates } from '../core/slots.js';
import type { PollResults } from '../services/results.js';
import { scriptJson } from './scriptJson.js';

// The poll page still lives here (Task 5 ports it); it needs the same escaping rule, which
// now has its own module so the React pages can share it. Re-exported for existing importers.
export { scriptJson };

/** What `html` actually returns; every view returns one of these. */
export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export interface PollPageData {
  rkey: string;
  title: string;
  description?: string;
  status: string;
  time: SpecificDates;
  slots: Interval[];
  results: PollResults;
  viewerDid: string | null;
  isHost: boolean;
  prefill?: { available: Interval[]; ifNeedBe: Interval[]; name?: string };
  editToken?: string;
  /** Guest responses still queued for the host's PDS; drives the "still syncing" banner. */
  pendingCount?: number;
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #17201c;
  background: #fbfbfa;
}
header {
  border-bottom: 1px solid #dcdfdd;
  padding: 12px 16px;
}
header .brand { font-weight: 700; letter-spacing: -0.01em; text-decoration: none; color: inherit; }
main { max-width: 900px; margin: 0 auto; padding: 16px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 24px 0 8px; }
h3 { font-size: 15px; margin: 16px 0 6px; }
p { margin: 6px 0; }
a { color: #1f6f4d; }
label { display: block; margin: 10px 0; font-size: 14px; }
input, select {
  display: block; width: 100%; max-width: 420px; margin-top: 4px;
  padding: 6px 8px; font: inherit;
  border: 1px solid #b9c0bc; border-radius: 4px; background: #fff; color: inherit;
}
button {
  font: inherit; padding: 6px 12px; border-radius: 4px;
  border: 1px solid #1f6f4d; background: #2b8a5f; color: #fff; cursor: pointer;
}
button.secondary { background: #fff; color: #1f6f4d; }
small { color: #5d6b64; }
.hint { color: #5d6b64; font-size: 13px; }
.banner {
  border: 1px solid #d9c07a; background: #fdf6e3; color: #5a4a17;
  border-radius: 4px; padding: 8px 12px; margin: 12px 0;
}
.pending { opacity: .6; }
.ranked { padding-left: 20px; }
.ranked li { margin: 6px 0; }
.ranked form { display: inline; margin-left: 8px; }
.responders { list-style: none; padding: 0; }
.responders li { padding: 2px 0; }
.toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
.toolbar > div { display: flex; gap: 6px; }
.zone { color: #5d6b64; font-size: 13px; }
button.zone { background: #fff; border-color: #b9c0bc; }
button.mode, button.view { background: #fff; color: #1f6f4d; }
button:disabled { opacity: .55; cursor: default; }
.col-head { font-size: 12px; font-weight: 600; padding: 2px 8px; }
.grid { display: flex; gap: 4px; overflow-x: auto; touch-action: none; }
.col { display: flex; flex-direction: column; }
.cell {
  border: 1px solid #ccc; padding: 2px 8px; font-size: 12px;
  user-select: none; cursor: pointer; min-width: 64px;
}
.cell.available { background: #2b8a5f; color: white; }
.cell.ifNeedBe {
  background: repeating-linear-gradient(45deg, #9fd6bd, #9fd6bd 4px, #d8efe4 4px, #d8efe4 8px);
}
/* Group view: read-only heatmap; the tint is set inline, per slot. */
.grid.readonly .cell { cursor: default; }
.cell.group { display: flex; justify-content: space-between; gap: 8px; min-width: 84px; }
.cell.hatch {
  background: repeating-linear-gradient(45deg, #9fd6bd, #9fd6bd 4px, #d8efe4 4px, #d8efe4 8px);
}
.tally { font-variant-numeric: tabular-nums; opacity: .85; }
.mode.active { outline: 2px solid #2b8a5f; }
button.mode.active, button.view.active { background: #2b8a5f; color: #fff; }
.view.active { outline: 2px solid #2b8a5f; }
.edit-link code { word-break: break-all; }
@media (max-width: 600px) { main { padding: 12px; } }
`;

export function layout(title: string, body: Html | string): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${raw(STYLE)}</style>
</head>
<body>
<header><a class="brand" href="/">letsmeet</a></header>
<main>${body}</main>
</body>
</html>`;
}

function fmtRange(slot: Interval, zone: string): string {
  const s = DateTime.fromISO(slot.start, { zone });
  const e = DateTime.fromISO(slot.end, { zone });
  return `${s.toFormat('HH:mm')}–${e.toFormat('HH:mm')} ${s.toFormat('ccc LLL d')}`;
}

export function pollPage(data: PollPageData): Html {
  const zone = data.time.timezone;
  const { responses, ranked } = data.results;
  const counts: Record<string, { available: string[]; ifNeedBe: string[] }> = {};
  for (const r of ranked) counts[r.slot.start] = { available: r.available, ifNeedBe: r.ifNeedBe };

  const gridData = {
    rkey: data.rkey,
    time: data.time,
    slots: data.slots,
    prefill: data.prefill,
    editToken: data.editToken,
    viewerDid: data.viewerDid,
    timezone: zone,
    counts,
  };

  const isActive = data.status === 'active';
  const showRanked = responses.length > 0 || data.isHost;
  const pending = data.isHost ? data.pendingCount ?? 0 : 0;

  const body = html`
${pending > 0
    ? html`<p class="banner">${pending} responses are still syncing to your account. If this persists for more than a day, sign in again to reconnect.</p>`
    : null}
<h1>${data.title}</h1>
${data.description ? html`<p class="description">${data.description}</p>` : null}
<p class="hint">Grid times are shown in your timezone; listed times are in the poll's timezone (${zone}).</p>
${isActive
    ? null
    : html`<p class="hint">This poll is ${data.status} — responses are closed.</p>`}

<p class="name-note">Guests are asked for a name when they save.
  <small>Shown publicly on this poll</small>.</p>
<div id="grid-root"></div>
<script id="poll-data" type="application/json">${raw(scriptJson(gridData))}</script>
<script type="module" src="/assets/grid.js"></script>

<section class="results">
  <h2>Results</h2>
  ${responses.length === 0 ? html`<p class="hint">No responses yet — share this page.</p>` : null}
  ${showRanked
    ? html`<ol class="ranked">${ranked.slice(0, 5).map((r) => html`<li>
      <span class="slot">${fmtRange(r.slot, zone)}</span>
      — ${r.available.length} available + ${r.ifNeedBe.length} if needed${r.missing.length
        ? html`, missing: ${r.missing.join(', ')}`
        : null}
      ${data.isHost && isActive
        ? html`<form method="post" action="/p/${data.rkey}/finalize">
          <input type="hidden" name="start" value="${r.slot.start}">
          <input type="hidden" name="end" value="${r.slot.end}">
          <button type="submit">Pick this time</button>
        </form>`
        : null}
    </li>`)}</ol>`
    : null}
  ${responses.length > 0
    ? html`<h3>Responses</h3>
    <ul class="responders">${responses.map((r) => html`<li class="${r.pending ? 'pending' : ''}">${r.who}${r.pending ? ' (syncing)' : ''}</li>`)}</ul>`
    : null}
</section>`;

  return layout(`${data.title} — letsmeet`, body);
}
