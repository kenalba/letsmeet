import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NonceContext } from './nonce.js';

/** Full-document render; every route returns `page(c, <Page …/>)` (see respond.ts). */
export function renderPage(node: ReactElement, nonce?: string): string {
  return '<!doctype html>' + renderToString(
    <NonceContext.Provider value={nonce}>{node}</NonceContext.Provider>,
  );
}
