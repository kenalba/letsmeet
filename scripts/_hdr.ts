import { Hono } from 'hono';
import { serve } from '@hono/node-server';
const app = new Hono();
app.post('/x', (c) => c.json({ host: c.req.header('host'), origin: c.req.header('origin'), sfs: c.req.header('sec-fetch-site'), url: c.req.url }));
serve({ fetch: app.fetch, port: 8798 });
