/**
 * Wires every `button[data-copy-path]` and `button[data-copy-url]` on the page. A path
 * button copies the CANONICAL path from the attribute (origin-prefixed at click time),
 * never `location.href` — a guest viewing through an edit link is on `/p/<rkey>/e/<token>`,
 * and sharing that would hand their private edit token to the group chat. A url button
 * copies its absolute URL verbatim: the availability feed's address is the same whichever
 * host the page is served on, and on `<name>.sez.<site>` the page's own origin is not it.
 * Buttons are server-rendered `hidden` and revealed here, so a no-JS page shows no button
 * that does nothing. Inline, not an island: three lines of DOM work per button don't earn
 * a bundle.
 */
export const COPY_LINK_SCRIPT = "(function(){var bs=document.querySelectorAll('button[data-copy-path],button[data-copy-url]');"
  + 'for(var i=0;i<bs.length;i++)(function(b){b.hidden=false;var t=b.textContent;'
  + "var url=b.getAttribute('data-copy-url')||location.origin+b.getAttribute('data-copy-path');"
  + "b.addEventListener('click',function(){"
  + "var done=function(){b.textContent='copied.';setTimeout(function(){b.textContent=t},1500)};"
  + "var ask=function(){window.prompt('copy this link:',url)};"
  + 'if(navigator.clipboard&&navigator.clipboard.writeText){'
  + 'navigator.clipboard.writeText(url).then(done,ask)}else{ask()}})})(bs[i])})()';
