/**
 * The sign-in page's handle field, enhanced. The list is created here, wrapped around the
 * server-rendered input, because the page has no island to render one.
 */
import { attachHandleTypeahead } from './handleTypeahead.js';

const el = document.getElementById('handle');
if (el instanceof HTMLInputElement) {
  const wrap = document.createElement('div');
  wrap.className = 'relative';
  el.parentElement!.insertBefore(wrap, el);
  wrap.appendChild(el);
  const list = document.createElement('ul');
  wrap.appendChild(list);
  attachHandleTypeahead(el, list);
}
