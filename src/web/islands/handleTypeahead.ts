/**
 * Handle typeahead. Progressive enhancement over a plain text input: without it the
 * field is exactly what it was. With it, the input becomes an ARIA combobox whose
 * suggestions come from our own `/api/handles` (see handleSearch.ts) — debounced,
 * cancellable, keyboard-navigable. Used by the sign-in page (login.ts) and by the grid's
 * inline sign-in (grid.tsx).
 */

interface Hit { handle: string; displayName?: string; avatar?: string }

const DEBOUNCE_MS = 150;

/** The suggestion list's look; the login page builds its list, the grid renders one. */
export const LIST_CLASS = 'absolute left-0 right-0 top-full z-10 mt-1 max-h-72 overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md';

/**
 * Turn `input` into a combobox fed by `list` (an empty `<ul>` positioned under it). Returns
 * a detach that cancels any pending or in-flight search; the listeners go with the nodes.
 */
export function attachHandleTypeahead(input: HTMLInputElement, list: HTMLUListElement): () => void {
  if (!list.id) list.id = 'handle-suggestions';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Matching handles');
  list.hidden = true;
  list.className = LIST_CLASS;

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', list.id);
  input.autocomplete = 'off';

  let hits: Hit[] = [];
  let active = -1;
  let timer: number | undefined;
  let inflight: AbortController | undefined;
  let lastQuery = '';

  const close = () => {
    hits = [];
    active = -1;
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  const choose = (i: number) => {
    const hit = hits[i];
    if (!hit) return;
    input.value = hit.handle;
    // Setting .value fires nothing; whoever watches the field (the grid's submit button)
    // needs to hear about it.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    close();
    input.focus();
  };

  const paint = () => {
    list.replaceChildren();
    hits.forEach((hit, i) => {
      const li = document.createElement('li');
      li.id = `${list.id}-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      li.className = `flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm ${
        i === active ? 'bg-primary/15' : ''}`;
      if (hit.avatar) {
        const img = document.createElement('img');
        img.src = hit.avatar;
        img.alt = '';
        img.width = 24;
        img.height = 24;
        img.loading = 'lazy';
        img.className = 'h-6 w-6 shrink-0 rounded-full bg-muted';
        li.appendChild(img);
      } else {
        const dot = document.createElement('span');
        dot.className = 'h-6 w-6 shrink-0 rounded-full bg-muted';
        dot.setAttribute('aria-hidden', 'true');
        li.appendChild(dot);
      }
      const text = document.createElement('span');
      text.className = 'flex min-w-0 flex-col leading-tight';
      const h = document.createElement('span');
      h.className = 'truncate font-medium';
      h.textContent = hit.handle;
      text.appendChild(h);
      if (hit.displayName) {
        const d = document.createElement('span');
        d.className = 'truncate text-xs text-muted-foreground';
        d.textContent = hit.displayName;
        text.appendChild(d);
      }
      li.appendChild(text);
      // mousedown, not click: the input's blur (which closes the list) fires in between.
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
      list.appendChild(li);
    });
    list.hidden = hits.length === 0;
    input.setAttribute('aria-expanded', String(hits.length > 0));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };

  const search = async (q: string) => {
    inflight?.abort();
    const ctl = new AbortController();
    inflight = ctl;
    try {
      const res = await fetch(`/api/handles?q=${encodeURIComponent(q)}`, {
        signal: ctl.signal, headers: { accept: 'application/json' },
      });
      if (!res.ok || ctl.signal.aborted) return;
      const body = (await res.json()) as { actors?: Hit[] };
      if (ctl.signal.aborted || input.value.trim() !== q) return;
      hits = (body.actors ?? []).filter((h) => h.handle !== q);
      active = -1;
      paint();
    } catch {
      // aborted or offline: keep whatever is showing
    }
  };

  input.addEventListener('input', () => {
    const q = input.value.trim();
    window.clearTimeout(timer);
    if (q.length < 2 || q === lastQuery) {
      if (q.length < 2) close();
      return;
    }
    timer = window.setTimeout(() => { lastQuery = q; void search(q); }, DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = (active + 1) % hits.length;
      paint();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active - 1 + hits.length) % hits.length;
      paint();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault(); // choose, don't submit, when a suggestion is highlighted
      choose(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      close();
    }
  });

    input.addEventListener('blur', () => close());

  return () => {
    window.clearTimeout(timer);
    inflight?.abort();
  };
}
