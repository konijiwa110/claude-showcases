// Dev only: what the interface does differently in the picture tools' headless browser.
//
// tools/pageshot.py photographs the page when --budget milliseconds of the browser's VIRTUAL time have passed. That
// clock stands still while a file is being fetched, walks from timer to timer while the page is idle, and jumps
// straight to the end when the page is idle and no timer is pending. Measured on this project (clocks printed on
// src/ui/lab.html?clocks=1):
//   - while the game loads, the clock races (models are decoded and shaders compiled off the main thread, so the
//     page is "idle", and every 10 ms poll of a loader moves it on at once): --budget 4000, 12000, 60000 and 90000
//     all photographed the loading screen, after 7 to 15 real seconds;
//   - once the game has loaded and only its frame loop runs, the picture is taken four or five frames later (about
//     20 ms of game time) whatever the budget is: no game time passes, and a CSS transition has barely begun.
//
// So, in a headless browser:
//   walk(ctx)     while the game loads, keep a 4 ms timer pending; whenever no frame has been drawn for a few ticks
//                 (the sign that the clock is racing, not being lived through) a tick does a few milliseconds of
//                 real work. The clock then runs at no more than about twice real time, and --budget becomes
//                 "about half as many real milliseconds allowed for loading": --budget 60000 is plenty. It stops at
//                 ui.loaded(). It is off in the runs that use real time (&shot, &perf) unless &page is given.
//   HEADLESS      the interface switches its CSS transitions and animations off (class "still" on its root), so
//                 every screen is photographed settled. &motion=1 keeps them.
//
// To photograph a moment of the real game with the interface over it, let the game's own picture run drive the
// clock: add &shot=<any name>.png&t=<seconds>&page to the address given to pageshot.py. src/dev.js then steps the
// game for exactly that long before anything is photographed, and &do=...@t things happen on the way.
//
// Nothing here runs in a player's browser.

/** True in the headless browser the picture tools start (its user agent says so), never in a player's browser. */
export const HEADLESS = /Headless/i.test(navigator.userAgent || '') || !!navigator.webdriver;

let sink = 0;
function work(n) { for (let i = 1; i < n; i++) sink += Math.sqrt(i) / i; return sink; }

/** Keep the picture tool's clock from racing while a page loads; returns a function that stops it. */
export function walk(ctx) {
  const p = ctx && ctx.params;
  if (!HEADLESS || !ctx || !ctx.dev || !p || p.has('perf') || p.get('walk') === '0' || (p.has('shot') && !p.has('page'))) return () => {};
  let ticks = 0, frameTick = 0, on = true;
  const frame = () => { if (on) { frameTick = ticks; requestAnimationFrame(frame); } };
  requestAnimationFrame(frame);
  const id = setInterval(() => { if (++ticks - frameTick > 3) work(900000); }, 4);
  return () => { on = false; clearInterval(id); };
}
