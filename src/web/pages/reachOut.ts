/**
 * Wires every `a[data-ping]` in the friend view's week grid — the free hours still ahead.
 * The anchor itself opens the person's Bluesky profile in a new tab (no script needed);
 * this copies the prefilled message in the same click and says so in the `.week-ping`
 * line under the grid, so one paste into their DMs finishes the job. Bluesky has no DM
 * intent URL and sending one needs a chat scope this app does not ask for, so the
 * clipboard is the whole bridge. Inline, nonce-tagged, no bundle: a page nothing hydrates.
 */
export const REACH_OUT_SCRIPT = "(function(){var as=document.querySelectorAll('a[data-ping]');"
  + "var out=document.querySelector('.week-ping');var say=function(t){if(out){out.textContent=t}};"
  + "for(var i=0;i<as.length;i++)(function(a){a.addEventListener('click',function(){"
  + "var m=a.getAttribute('data-ping');"
  + 'if(navigator.clipboard&&navigator.clipboard.writeText){'
  + "navigator.clipboard.writeText(m).then(function(){say('copied \"'+m+'\". paste it into their dms.')},"
  + "function(){say('could not copy. your message: '+m)})}"
  + "else{say('your message: '+m)}})})(as[i])})()";
