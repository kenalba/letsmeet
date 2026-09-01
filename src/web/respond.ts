import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ReactElement } from 'react';
import { renderPage } from './render.js';

/** Render a page with this response's CSP nonce threaded through to its inline scripts. */
export function page(c: Context, node: ReactElement, status: ContentfulStatusCode = 200): Response {
  return c.html(renderPage(node, c.get('secureHeadersNonce')), status);
}
