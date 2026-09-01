import { Hono } from 'hono';
import { TokenBucket } from '../rateLimit.js';
import { clientIp } from '../clientIp.js';
import type { HandleSearch } from '../handleSearch.js';

/** Longest query the typeahead will forward; handles and names are short. */
const MAX_QUERY = 64;

export function apiRoutes(search: HandleSearch, now: () => Date): Hono {
  const app = new Hono();
  // Typing is bursty: a generous burst, a modest sustained rate, per address. Each miss
  // is one upstream request, so this is also the cap on what we can be made to send.
  const limiter = new TokenBucket(40, 4);

  app.get('/api/handles', async (c) => {
    if (!limiter.allow(clientIp(c), now().getTime())) {
      return c.json({ error: 'easy there.' }, 429);
    }
    const q = (c.req.query('q') ?? '').trim();
    if (q.length === 0 || q.length > MAX_QUERY) {
      return c.json({ error: 'q must be 1–64 characters.' }, 400);
    }
    try {
      return c.json({ actors: await search(q) }, 200, { 'Cache-Control': 'private, max-age=60' });
    } catch (err) {
      // An unreachable AppView degrades to "no suggestions", never to a broken form.
      console.warn('handle typeahead failed:', (err as Error).message);
      return c.json({ actors: [] }, 200, { 'Cache-Control': 'no-store' });
    }
  });

  return app;
}
