import { fitLabel } from '../../core/labelFit.js';

/**
 * The friend view's note labels, classified once the page has laid out and again on resize.
 * The server places each label in its away block and guesses an orientation from the shape
 * of it (vertical down one column, horizontal across a span) so a page with no JavaScript
 * reads sensibly; this measures the real box and asks `fitLabel` — the same function the
 * editor island calls — which of h/v, one line or wrapped, actually fits.
 *
 * The rule cannot drift because this ships `fitLabel`'s own source: `fitLabel.toString()`.
 * Two things follow from that, both guarded by tests: the function must stay
 * self-contained (see its comment), and `__name` is defined here as a pass-through because
 * esbuild's keep-names transform calls it around inner functions and a browser has never
 * heard of it.
 *
 * Rebuilding `className` is deliberate — the server's guess has to go — so the "past" flag
 * comes back off `data-past` rather than surviving in the class list.
 */
export const ZONE_LABEL_SCRIPT = '(function(){'
  + 'var __name=function(f){return f};'
  + `var fitLabel=${fitLabel.toString()};`
  // The friend view's label metrics: 10px/12px with 2-3px of padding (see app.css).
  + 'var font={charWidth:5,lineHeight:12,pad:3};'
  + 'var run=function(){'
  + "var ls=document.querySelectorAll('.week .zlabel');"
  + 'for(var i=0;i<ls.length;i++){var el=ls[i];var r=el.getBoundingClientRect();'
  + "var f=fitLabel(el.textContent||'',r.width,r.height,font);"
  + "el.className='zlabel '+f.orient+(f.lines===1?' one':'')"
  + "+(el.getAttribute('data-past')==='1'?' past':'')}};"
  + "run();window.addEventListener('resize',run)})()";
