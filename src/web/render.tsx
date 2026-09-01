import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';

/** Full-document render; every route returns c.html(renderPage(<Page …/>)). */
export function renderPage(node: ReactElement): string {
  return '<!doctype html>' + renderToString(node);
}
