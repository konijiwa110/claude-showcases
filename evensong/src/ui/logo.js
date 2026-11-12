// The logo. It lives in ONE file, assets/ui/logo.svg (drawn by src/ui/logo/draw.py): if the game is renamed, that
// file and NAME below are all that change. This module fetches the file once and puts copies of it in the page,
// inline, so that the page's styles can tint the letters and light the flame (an <img> could not be reached).
// Until the file has arrived, and for good if it cannot be read, the name is set in the interface's serif.
//
// What the file must hold (see the comment at its top): one <svg viewBox="0 0 W H"> with a group class="letters"
// (the lettering) and a group class="flame" (the one ornament; the styles make it flicker and put it out).
// Any id="..." in it must begin with "evs-": copies are renumbered so that several can be on the page at once.

export const NAME = 'Evensong';
export const LOGO_URL = new URL('../../assets/ui/logo.svg', import.meta.url).href;

let pending = null, copies = 0;

function fetchLogo() {
  if (!pending) {
    pending = fetch(LOGO_URL).then((r) => { if (!r.ok) throw new Error(r.status + ' ' + LOGO_URL); return r.text(); }).then((text) => {
      const m = text.match(/<svg[\s\S]*<\/svg>/i);
      if (!m) throw new Error('no <svg> in ' + LOGO_URL);
      const box = (m[0].match(/viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/) || [0, 0, 0]);
      return { markup: m[0].replace(/<script[\s\S]*?<\/script>/gi, ''), ratio: +box[1] && +box[2] ? +box[1] / +box[2] : 0 };
    });
    pending.catch(() => {});
  }
  return pending;
}

/** Resolves when the logo's file has been read (or could not be). */
export function logoReady() { return fetchLogo().then(() => true, () => false); }

/**
 * Put the logo in `holder` (an empty element). Returns a promise that resolves to true when the drawing is in,
 * false if the file could not be read (the name then stays set in type).
 */
export function mountLogo(holder) {
  holder.classList.add('evs-logo');
  holder.setAttribute('role', 'img'); holder.setAttribute('aria-label', NAME);
  holder.innerHTML = `<span class="evs-wordmark">${NAME}</span>`;
  return fetchLogo().then((logo) => {
    const n = ++copies;
    // two copies: a blurred dark one underneath (so the letters hold against a bright picture) and the drawing itself.
    // The shade is a separate, still layer, so the flame can flicker without the blur being worked out again.
    const one = (cls) => logo.markup.replace(/evs-/g, `evs${n}${cls[0]}-`).replace(/<svg/i, `<svg class="${cls}" aria-hidden="true" focusable="false"`);
    holder.innerHTML = one('shade') + one('ink');
    if (logo.ratio) holder.style.aspectRatio = String(logo.ratio);
    holder.classList.add('drawn');
    return true;
  }, (err) => { console.warn('The logo could not be read; the name is set in type instead. ' + (err && err.message ? err.message : err)); return false; });
}
