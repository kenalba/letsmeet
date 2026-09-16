import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ReactElement } from 'react';
import { ValidationError } from '@atproto/lexicon';
import { GENERIC_ERROR, UserError } from '../core/errors.js';
import { renderPage } from './render.js';

/** Render a page with this response's CSP nonce threaded through to its inline scripts. */
export function page(c: Context, node: ReactElement, status: ContentfulStatusCode = 200): Response {
  return c.html(renderPage(node, c.get('secureHeadersNonce')), status);
}

/**
 * What a failed request tells the client. Messages written for a person (UserError) and the
 * lexicon's own field-level complaints ("title must not be longer than…") are shown as they
 * are; anything else is logged here, under `where`, and replaced with a line that names
 * nothing. Every route answers a failure the same way, so it lives beside `page`.
 */
export function explain(err: unknown, where: string): string {
  if (err instanceof UserError || err instanceof ValidationError) return err.message;
  console.error(`${where} failed:`, err);
  return GENERIC_ERROR;
}
