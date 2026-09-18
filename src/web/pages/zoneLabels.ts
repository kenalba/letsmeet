import { fitLabel, FRIEND_LABEL_FONT } from '../../core/labelFit.js';

/**
 * The friend view's note labels, classified once the page has laid out and again on resize.
 * The server places each label in its away block and guesses an orientation from the shape
 * of it (vertical down one column, horizontal across a span) so a page with no JavaScript
 * reads sensibly; this measures the real box and asks `fitLabel` — the same function the
 * editor island calls — which of h/v, one line or wrapped, actually fits.
 *
 * The rule cannot drift because this ships `fitLabel`'s own source: `fitLabel.toString()`.
 * That is why the function has to stay self-contained (see its comment), and why the font
 * travels as JSON rather than as the imported constant. `__name` is insurance: if esbuild's
 * keep-names transform is ever turned on it wraps inner functions in a call to it, and a
 * browser has never heard of the name. No other shim is warranted — the payload is `fitLabel`
 * verbatim, so it already needs an ES2015 engine.
 *
 * Every box is measured before any class is written: a className write invalidates style,
 * and interleaving the two would make each `getBoundingClientRect` re-run layout.
 *
 * Rebuilding `className` is deliberate — the server's guess has to go — so the "past" flag
 * comes back off `data-past` rather than surviving in the class list.
 */
export const ZONE_LABEL_SCRIPT = '(function(){'
  + 'var __name=function(f){return f};'
  + `var fitLabel=${fitLabel.toString()};`
  + `var font=${JSON.stringify(FRIEND_LABEL_FONT)};`
  + 'var run=function(){'
  + "var ls=document.querySelectorAll('.week .zlabel');var fits=[];"
  + 'for(var i=0;i<ls.length;i++){var r=ls[i].getBoundingClientRect();'
  + "fits.push(fitLabel(ls[i].textContent||'',r.width,r.height,font))}"
  + 'for(var j=0;j<ls.length;j++){var el=ls[j];var f=fits[j];'
  + "el.className='zlabel '+f.orient+(f.lines===1?' one':'')"
  + "+(el.getAttribute('data-past')==='1'?' past':'')}};"
  // The listeners first, then the first run: a web font landing after paint changes every
  // box, and `load` is when that is settled.
  + "window.addEventListener('load',run);window.addEventListener('resize',run);"
  + 'window.requestAnimationFrame(run)})()';
