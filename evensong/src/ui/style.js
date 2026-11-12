// Every colour, size and shape of the interface: one stylesheet, put in the page while an interface exists and taken
// out with the last one. Every rule is scoped to the interface's root (class "evs"), so nothing leaks into the page;
// the only global names are the two font families and the keyframes, all prefixed "evs" / "Evs".
//
// To re-theme: the custom properties at the top of the ".evs" rule hold the palette and the two type families.
//
// Sizes: --u is one pixel when the window is 1600 x 900, and follows the window between about 0.7 and 1.9. Marks and
// spacing are multiples of it; type has a floor in real pixels so that it still reads in a small window.
const FONTS = new URL('../../assets/fonts/', import.meta.url).href;

const CSS = `
@font-face { font-family: "Evs Caslon"; src: url("${FONTS}libre-caslon-text-400.woff2") format("woff2"); font-weight: 400; font-style: normal; font-display: block; }
@font-face { font-family: "Evs Caslon"; src: url("${FONTS}libre-caslon-text-400-italic.woff2") format("woff2"); font-weight: 400; font-style: italic; font-display: block; }
@font-face { font-family: "Evs Ysabeau"; src: url("${FONTS}ysabeau-office-400-700.woff2") format("woff2"); font-weight: 400 700; font-style: normal; font-display: block; }

.evs {
  --u: clamp(.7px, min(.0625vw, .1111vh), 1.9px);
  --hair: max(1px, calc(var(--u) * .9));
  --bar: max(0px, calc((100vh - 100vw / 2.39) / 2));          /* a cutscene's bars: the picture is 2.39 to 1 */
  --ivory: #ece3cd; --ivory-2: #bdb39c; --ivory-3: #8f8775;   /* words: bright, quiet, small print */
  --brass: #cfb57c; --gold: #ecd9a2;                          /* hairlines and marks; what is chosen */
  --flame: #f1bb58; --flame-core: #fff2cc;
  --blood: #a3382f; --verd: #84a791;                          /* health; stamina */
  --ink: #05070b;
  --serif: "Evs Caslon", "Libre Caslon Text", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --sans: "Evs Ysabeau", "Ysabeau Office", "Gill Sans", "Segoe UI", system-ui, sans-serif;
  --shade: 0 1px 2px rgba(0,0,0,.92), 0 0 calc(var(--u) * 14) rgba(0,0,0,.62);
  font: 400 calc(var(--u) * 18)/1.35 var(--serif); color: var(--ivory);
  overflow: hidden; cursor: default; user-select: none; -webkit-user-select: none;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; font-kerning: normal; font-synthesis: none;
}
.evs *, .evs *::before, .evs *::after { box-sizing: border-box; margin: 0; padding: 0; }
.evs i, .evs b, .evs em { font-style: normal; font-weight: inherit; }
.evs i { display: block; }
.evs svg { display: block; overflow: visible; }
.evs-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* ---------------------------------------------------------------- marks: keys, mouse, gamepad */
.evs-g { display: inline-flex; align-items: center; gap: .3em; vertical-align: middle; }
.evs-k, .evs-p { position: relative; display: inline-flex; align-items: center; justify-content: center; min-width: 1.7em; height: 1.7em; padding: 0 .36em;
  font: 600 .74em/1 var(--sans); letter-spacing: .03em; color: var(--ivory); text-shadow: none; white-space: nowrap;
  border: var(--hair) solid rgba(207,181,124,.6); border-radius: .28em; background: rgba(5,7,11,.52); box-shadow: 0 var(--hair) 0 rgba(207,181,124,.26); }
.evs-k.evs-w { padding: 0 .6em; }
.evs-k.evs-ar { font-weight: 500; }
.evs-p { border-radius: 50%; padding: 0; box-shadow: none; }
.evs-p.evs-st { box-shadow: 0 0 0 .14em rgba(5,7,11,.5), 0 0 0 calc(.14em + var(--hair)) rgba(207,181,124,.42); margin: 0 .16em; }
.evs-p.evs-cl::after { content: ''; position: absolute; left: 50%; bottom: -.62em; width: .5em; height: .3em; margin-left: -.25em; background: rgba(207,181,124,.8); clip-path: polygon(0 0, 100% 0, 50% 100%); }
.evs-p.evs-dp { border-radius: .28em; border-color: transparent; background: none; }
.evs-p.evs-dp::before, .evs-p.evs-dp::after { content: ''; position: absolute; left: 50%; top: 50%; background: rgba(5,7,11,.52); border: var(--hair) solid rgba(207,181,124,.6); border-radius: .12em; }
.evs-p.evs-dp::before { width: .56em; height: 1.6em; margin: -.8em 0 0 -.28em; }
.evs-p.evs-dp::after { width: 1.6em; height: .56em; margin: -.28em 0 0 -.8em; }
.evs-m { display: inline-block; width: .9em; height: 1.28em; vertical-align: middle; }
.evs-m svg { width: 100%; height: 100%; }
.evs-i-mouse .s { fill: rgba(5,7,11,.45); stroke: rgba(207,181,124,.82); stroke-width: 1.1; stroke-linejoin: round; }
.evs-i-mouse .b { fill: var(--ivory); }
.evs-plus { opacity: .6; font: 500 .8em/1 var(--sans); }

/* ---------------------------------------------------------------- cutscene bars, fade */
.evs-lbx { position: absolute; left: 0; right: 0; height: var(--bar); background: #000; will-change: transform; }
.evs-lbx.t { top: 0; transform: translateY(-101%); }
.evs-lbx.b { bottom: 0; transform: translateY(101%); }
.evs-fade { position: absolute; inset: 0; background: #000; opacity: 0; }

/* ---------------------------------------------------------------- the HUD */
.evs-hud { position: absolute; inset: 0; opacity: 0; visibility: hidden; transition: opacity .3s ease, visibility 0s .3s; }
.evs[data-screen="hud"] .evs-hud { opacity: 1; visibility: visible; transition: opacity .7s ease .1s, visibility 0s; }

.evs-vit { position: absolute; left: max(16px, calc(var(--u) * 40)); top: max(14px, calc(var(--u) * 34)); display: flex; align-items: center; }
.evs-vit .lamp { position: relative; z-index: 1; flex: none; width: calc(var(--u) * 42); height: calc(var(--u) * 42); margin-right: calc(var(--u) * 5); filter: drop-shadow(0 0 calc(var(--u) * 3) rgba(0,0,0,.8)); }
.evs-vit .lamp svg { width: 100%; height: 100%; }
.evs-i-lamp .r { fill: rgba(5,7,11,.5); stroke: var(--brass); stroke-width: 1.1; }
.evs-i-lamp .h { fill: rgba(241,187,88,.13); transition: opacity 1s ease; }
.evs-i-lamp .f { transform-box: fill-box; transform-origin: 50% 100%; transition: opacity 1.4s ease; filter: drop-shadow(0 0 2.5px rgba(241,170,70,.7)); }
.evs-i-lamp .o, .evs-i-flame .o { fill: var(--flame); }
.evs-i-lamp .c, .evs-i-flame .c { fill: var(--flame-core); }
.evs-vit .lamp.low .f { animation: evs-gutter 1.15s ease-in-out infinite; }
.evs-vit .lamp.low .h { opacity: .4; }
.evs-vit .lamp.out .f, .evs-vit .lamp.out .h { opacity: 0; }
.evs-vit .bars { display: flex; flex-direction: column; gap: calc(var(--u) * 7); }

.evs-bar { position: relative; height: max(5px, calc(var(--u) * 8)); background: rgba(5,7,11,.68);
  box-shadow: 0 0 0 var(--hair) rgba(207,181,124,.5), 0 0 0 calc(var(--hair) * 2) rgba(0,0,0,.4), 0 calc(var(--u) * 2) calc(var(--u) * 10) rgba(0,0,0,.5); }
.evs-bar > i { position: absolute; inset: 0; transform-origin: 0 50%; will-change: transform; }
.evs-bar .fi { background: linear-gradient(#c65a4f, #a3382f 46%, #7b2420); }
.evs-bar .fi::after { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 1px; background: rgba(255,222,205,.34); }
.evs-bar .tr { background: #eadcb6; opacity: .9; }
.evs-bar .fx { background: #fff1d8; opacity: 0; will-change: opacity; }
.evs-bar .cap { position: absolute; right: calc(var(--hair) * -1); top: calc(var(--u) * -3); bottom: calc(var(--u) * -3); width: var(--hair); background: rgba(207,181,124,.75); }
.evs-bar.hp.low { animation: evs-low 1.5s ease-in-out infinite; }
.evs-bar.st { height: max(4px, calc(var(--u) * 6)); }
.evs-bar.st .fi { background: linear-gradient(#a3c4ae, #84a791 48%, #5f8370); transition: filter .35s ease; }
.evs-bar.st .tr { background: #dfe6d0; opacity: .55; }
.evs-bar.st.dull .fi { filter: saturate(.12) brightness(.74); }

.evs-flasks { position: absolute; left: max(16px, calc(var(--u) * 46)); bottom: max(14px, calc(var(--u) * 38)); display: flex; align-items: center; gap: calc(var(--u) * 14); font-size: max(12px, calc(var(--u) * 16)); }
.evs-flasks.none { display: none; }
.evs-flasks .row { display: flex; gap: calc(var(--u) * 7); }
.evs-flasks .fl { width: calc(var(--u) * 20); height: calc(var(--u) * 28); filter: drop-shadow(0 1px calc(var(--u) * 3) rgba(0,0,0,.75)); }
.evs-flasks .fl svg { width: 100%; height: 100%; }
.evs-i-flask .k { fill: rgba(5,7,11,.5); }
.evs-i-flask .g { fill: none; stroke: var(--brass); stroke-width: 1.15; stroke-linejoin: round; transition: stroke .6s ease; }
.evs-i-flask .q { fill: #dfa650; transform-box: fill-box; transform-origin: 50% 100%; transition: transform .7s cubic-bezier(.4,0,.6,1), opacity .7s ease; }
.evs-flasks .fl.used .q { transform: scaleY(0); opacity: 0; }
.evs-flasks .fl.used .g { stroke: rgba(207,181,124,.4); }
.evs-flasks .fl.still .q, .evs-flasks .fl.still .g { transition: none; }
.evs-flasks .key { opacity: .7; }

.evs-boss { position: absolute; left: 50%; bottom: max(20px, calc(var(--u) * 52)); width: min(calc(var(--u) * 860), 72vw); transform: translateX(-50%); opacity: 0; transition: opacity .5s ease; }
.evs-boss.on { opacity: 1; transition: opacity 1.3s ease .25s; }
.evs-boss .head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: calc(var(--u) * 10); padding: 0 calc(var(--u) * 1); }
.evs-boss .nm { font-size: max(14px, calc(var(--u) * 20)); line-height: 1.1; letter-spacing: .012em; white-space: nowrap; text-shadow: var(--shade); }
.evs-boss .dmg { font: 500 max(13px, calc(var(--u) * 18))/1 var(--sans); font-variant-numeric: lining-nums tabular-nums; letter-spacing: .04em; text-shadow: var(--shade); opacity: 0; }
.evs-bar.bb { height: max(5px, calc(var(--u) * 7)); }
.evs-bar.bb .tr { background: #ead7a4; }
.evs-bar.bb .evs-i-loz { position: absolute; top: 50%; width: calc(var(--u) * 10); height: calc(var(--u) * 10); margin-top: calc(var(--u) * -5); fill: var(--brass); filter: drop-shadow(0 0 calc(var(--u) * 2) rgba(0,0,0,.9)); }
.evs-bar.bb .evs-i-loz:nth-of-type(1) { left: calc(var(--u) * -13); }
.evs-bar.bb .evs-i-loz:nth-of-type(2) { right: calc(var(--u) * -13); }

.evs-lock { position: absolute; left: 0; top: 0; width: 0; height: 0; will-change: transform; }
.evs-lock span { position: absolute; left: calc(var(--u) * -15); top: calc(var(--u) * -15); width: calc(var(--u) * 30); height: calc(var(--u) * 30); opacity: 0; transform: scale(2) rotate(45deg); transition: opacity .12s ease, transform .12s ease; }
.evs-lock span svg { width: 100%; height: 100%; }
.evs-lock.on span { opacity: 1; transform: none; transition: opacity .16s ease, transform .34s cubic-bezier(.2,.9,.25,1); }
.evs-i-lock .d { fill: none; stroke: rgba(5,7,11,.72); stroke-width: 3.6; stroke-linejoin: round; }
.evs-i-lock .d circle { fill: rgba(5,7,11,.72); stroke-width: 2.2; }
.evs-i-lock .l { fill: none; stroke: #f4ebd6; stroke-width: 1.25; }
.evs-i-lock .l circle { fill: #f4ebd6; stroke: none; }

.evs-prompt { position: absolute; left: 50%; bottom: 23%; transform: translateX(-50%); display: flex; align-items: center; gap: .55em; white-space: nowrap;
  font-size: max(14px, calc(var(--u) * 19)); text-shadow: var(--shade); opacity: 0; transition: opacity .3s ease; }
.evs-prompt.on { opacity: .95; }

/* ---------------------------------------------------------------- banners */
.evs-banner { position: absolute; left: 0; right: 0; top: 50%; height: calc(var(--u) * 250); transform: translateY(-54%); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: calc(var(--u) * 22); visibility: hidden; }
.evs-banner.live { visibility: visible; }
.evs-banner .band { position: absolute; inset: 0; opacity: 0; background: linear-gradient(rgba(2,3,6,0), rgba(2,3,6,.8) 30%, rgba(2,3,6,.87) 50%, rgba(2,3,6,.8) 70%, rgba(2,3,6,0)); }
.evs-banner .ru { position: relative; width: min(calc(var(--u) * 720), 78vw); height: var(--hair); opacity: 0; background: linear-gradient(90deg, transparent, currentColor 24%, currentColor 76%, transparent); }
.evs-banner .tx { position: relative; opacity: 0; font-size: clamp(20px, calc(var(--u) * 52), 4.4vw); line-height: 1; letter-spacing: .32em; margin-right: -.32em; text-transform: uppercase; white-space: nowrap; will-change: transform, opacity; }
.evs-banner.death { color: #a0352d; }
.evs-banner.death .tx { text-shadow: 0 0 calc(var(--u) * 34) rgba(150,28,20,.45), 0 calc(var(--u) * 2) calc(var(--u) * 3) rgba(0,0,0,.9); }
.evs-banner.victory { color: #ead7a0; }
.evs-banner.victory .tx { text-shadow: 0 0 calc(var(--u) * 36) rgba(232,190,104,.36), 0 calc(var(--u) * 2) calc(var(--u) * 3) rgba(0,0,0,.9); }

/* ---------------------------------------------------------------- cutscenes: her name, a spoken line, the skip hint */
.evs-name { position: absolute; left: 50%; bottom: calc(var(--bar) + 6.5vh); transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: calc(var(--u) * 13); white-space: nowrap; opacity: 0; }
.evs-name .tx { font-size: max(18px, calc(var(--u) * 30)); line-height: 1.1; letter-spacing: .015em; text-shadow: 0 1px 2px rgba(0,0,0,.95), 0 0 calc(var(--u) * 18) rgba(0,0,0,.78); }
.evs-name .ru { width: 100%; height: var(--hair); opacity: .75; background: linear-gradient(90deg, transparent, var(--brass) 20%, var(--brass) 80%, transparent); }

.evs-sub { position: absolute; left: 50%; bottom: max(calc(var(--u) * 50), calc(var(--bar) * .5)); transform: translate(-50%, 50%); width: max-content; max-width: min(84vw, 44em); text-align: center; text-wrap: balance;
  font-size: max(16px, calc(var(--u) * 25)); line-height: 1.36; opacity: 0;
  text-shadow: 0 1px 2px #000, 0 0 calc(var(--u) * 10) rgba(0,0,0,.88), 0 0 calc(var(--u) * 26) rgba(0,0,0,.6); }

.evs-skip { position: absolute; right: max(16px, calc(var(--u) * 44)); bottom: max(calc(var(--u) * 34), calc(var(--bar) * .5)); transform: translateY(50%); display: flex; align-items: center; gap: .7em; white-space: nowrap;
  font: 500 max(12px, calc(var(--u) * 14.5))/1 var(--sans); letter-spacing: .08em; color: var(--ivory-2); text-shadow: var(--shade); opacity: 0; transition: opacity .4s ease; }
.evs-skip.on { opacity: 1; transition: opacity .2s ease; }
.evs-i-ring { width: 1.9em; height: 1.9em; }
.evs-i-ring .t { fill: rgba(5,7,11,.4); stroke: rgba(207,181,124,.34); stroke-width: 1.3; }
.evs-i-ring .v { fill: none; stroke: var(--gold); stroke-width: 1.9; stroke-dasharray: 100; stroke-dashoffset: 100; }

/* ---------------------------------------------------------------- the logo */
.evs-logo { position: relative; display: block; aspect-ratio: 5.2; container-type: inline-size; color: var(--ivory); }
.evs-logo svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.evs-logo .shade { opacity: .6; filter: blur(calc(var(--u) * 7)); transform: translateY(calc(var(--u) * 2)); }
.evs-logo .shade * { fill: #000 !important; stroke: #000 !important; }
.evs-logo .shade .flame { display: none; }
.evs-logo .ink .flame { transform-box: fill-box; transform-origin: 50% 100%; }
.evs-wordmark { display: flex; align-items: center; justify-content: center; height: 100%; font: 400 12cqw/1 var(--serif); letter-spacing: .14em; margin-right: -.14em; text-transform: uppercase; text-shadow: var(--shade); }

/* where the logo stands on the title.
   The title's picture keeps the Cantor and the rose window in the right third (src/cine/title.js), so the title
   block (logo and menu) is centred on --title-x, left of the middle: at 16 to 9 the logo runs from 9 to 55 per cent
   of the width. In a narrow window it moves back toward the middle so that it never leaves the page. */
/* (last polish: the logo was 900 wide and ran to 65 per cent of the width: its last letter lay over the edge of her
   folded wing, a pale G on gold pipes. 740 wide and centred at 32 per cent it ends at 55 per cent, clear of the wing.) */
.evs { --logo-w: min(calc(var(--u) * 740), 88vw); --title-x: clamp(calc(var(--logo-w) / 2 + 5vw), 32vw, 50vw); }
.evs-spot { position: absolute; left: var(--title-x); bottom: calc(var(--u) * 222); width: var(--logo-w); transform: translateX(-50%); }

/* ---------------------------------------------------------------- loading: dark, the logo's ghost, a thin line filling */
.evs-load { position: absolute; inset: 0; background: var(--ink); transition: opacity .4s ease, visibility 0s .4s; }
.evs-load.gone { opacity: 0; visibility: hidden; }
.evs-load.slow { transition: opacity 2.6s cubic-bezier(.45,0,.2,1) 1.2s, visibility 0s 3.8s; }
/* the loading card is its own: the ghost in the middle of the dark, the line under it. It goes first; then the title rises in its own place. */
.evs-load .evs-spot { left: 50%; top: 47%; bottom: auto; width: min(calc(var(--u) * 680), 80vw); transform: translate(-50%, -50%); transition: opacity .45s ease; }
.evs-load.gone .evs-spot { opacity: 0; }
.evs-load .evs-logo .ink { opacity: .13; }
.evs-load .evs-logo .shade, .evs-load .evs-logo .ink .flame { display: none; }
.evs-load .evs-wordmark { opacity: .13; text-shadow: none; }
.evs-load .line { position: absolute; left: 50%; top: calc(100% + var(--u) * 34); width: 30%; height: var(--hair); transform: translateX(-50%); background: rgba(207,181,124,.2); transition: opacity .5s ease; }
.evs-load .line i { position: absolute; inset: 0; background: var(--gold); transform-origin: 0 50%; transform: scaleX(0); transition: transform .3s ease-out; }

/* ---------------------------------------------------------------- screens with choices */
.evs-menus { position: absolute; inset: 0; pointer-events: none; }
.evs-menus.open { pointer-events: auto; }
.evs-veil { position: absolute; inset: 0; opacity: 0; transition: opacity .4s ease; }
.evs-veil.vt { background: linear-gradient(rgba(5,7,11,.32) 0%, rgba(5,7,11,0) 20%, rgba(5,7,11,0) 36%, rgba(5,7,11,.52) 60%, rgba(5,7,11,.9) 100%); }
.evs-veil.vp { background: radial-gradient(130% 100% at 50% 46%, rgba(5,7,11,.72) 0%, rgba(4,5,9,.9) 100%); }
.evs-veil.ve { background: radial-gradient(90% 80% at 50% 50%, rgba(5,7,11,.8) 0%, rgba(5,7,11,.45) 100%); }
.evs-menus[data-panel="title"] .vt, .evs-menus[data-panel="pause"] .vp, .evs-menus[data-panel="ask"] .vp, .evs-menus[data-panel="options"] .vp, .evs-menus[data-panel="end"] .ve { opacity: 1; transition: opacity .8s ease; }

.evs-panel { position: absolute; inset: 0; opacity: 0; visibility: hidden; transition: opacity .25s ease, visibility 0s .25s; }
.evs-panel.cur { opacity: 1; visibility: visible; transition: opacity .45s ease .1s, visibility 0s; }
.evs-menus.leaving .evs-panel.cur { opacity: 0; transition: opacity .3s ease; }

.evs-list { display: flex; flex-direction: column; align-items: center; gap: calc(var(--u) * 4); }
.evs-list .it, .evs-rows .it { position: relative; cursor: pointer; white-space: nowrap; color: var(--ivory-2); text-shadow: var(--shade); transition: color .16s ease; }
.evs-list .it { padding: calc(var(--u) * 6) calc(var(--u) * 36); font-size: max(17px, calc(var(--u) * 25)); line-height: 1.25; letter-spacing: .015em; }
.evs-list .it::before, .evs-list .it::after, .evs-rows .it::before { content: ''; position: absolute; top: 50%; width: calc(var(--u) * 8); height: calc(var(--u) * 12); margin-top: calc(var(--u) * -6);
  background: var(--gold); clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); opacity: 0; transform: scale(.3); transition: opacity .16s ease, transform .22s ease; }
.evs-list .it::before, .evs-rows .it::before { left: calc(var(--u) * 6); }
.evs-list .it::after { right: calc(var(--u) * 6); }
.evs-list .it.on, .evs-rows .it.on { color: #f7f0dd; }
.evs-list .it.on::before, .evs-list .it.on::after, .evs-rows .it.on::before { opacity: 1; transform: none; }

.evs-legend, .evs-keys { position: absolute; left: 0; right: 0; bottom: max(12px, calc(var(--u) * 28)); display: flex; flex-wrap: wrap; justify-content: center; gap: calc(var(--u) * 8) calc(var(--u) * 28); padding: 0 4vw;
  font: 500 max(11.5px, calc(var(--u) * 13.5))/1.2 var(--sans); letter-spacing: .07em; color: var(--ivory-3); text-shadow: 0 1px 2px rgba(0,0,0,.9); }
.evs-legend .e, .evs-keys .e { display: inline-flex; align-items: center; gap: .55em; white-space: nowrap; }

/* the title: the logo low over the water, the menu under it, the keys in small print at the foot */
.evs-title .evs-list { position: absolute; left: var(--title-x); bottom: calc(var(--u) * 92); transform: translateX(-50%); }
.evs-title .ink .letters, .evs-title .shade, .evs-title .evs-wordmark { opacity: 0; transition: opacity .3s ease; }
.evs-title .ink .flame { opacity: 0; transition: opacity .3s ease; }
.evs-title.cur .ink .letters, .evs-title.cur .shade, .evs-title.cur .evs-wordmark { opacity: 1; transition: opacity .8s ease .1s; }
.evs-title.cur .shade { opacity: .6; }
.evs-title.cur .ink .flame { opacity: 1; transition: opacity .8s ease .1s; animation: evs-flicker 4.3s ease-in-out infinite; filter: drop-shadow(0 0 calc(var(--u) * 10) rgba(241,170,70,.62)); }
.evs-title .evs-list, .evs-title .evs-legend { opacity: 0; transition: opacity .25s ease; }
.evs-title.cur .evs-list { opacity: 1; transition: opacity .7s ease .3s; }
.evs-title.cur .evs-legend { opacity: 1; transition: opacity .7s ease .5s; }
/* the first time, after loading: the loading card goes, the flame lights, the letters follow, the hall rises behind, then the choices */
.evs.first .evs-title.cur .ink .flame { transition: opacity 1.1s ease .45s; }
.evs.first .evs-title.cur .ink .letters, .evs.first .evs-title.cur .evs-wordmark { transition: opacity 2.2s ease .9s; }
.evs.first .evs-title.cur .shade { transition: opacity 2.4s ease 1.8s; }
.evs.first .evs-title.cur .evs-list { transition: opacity 1.1s ease 3.3s; }
.evs.first .evs-title.cur .evs-legend { transition: opacity 1.1s ease 3.9s; }

/* pause, the question, options: a column of choices on a dark veil */
.evs-pause, .evs-ask, .evs-options { display: flex; flex-wrap: wrap; align-items: center; align-content: center; justify-content: center; gap: calc(var(--u) * 34) calc(var(--u) * 80); padding: 4vh 5vw 9vh; }
@media (max-aspect-ratio: 1/1) { .evs-pause .evs-card { padding-left: 0; border-left: 0; } }       /* a tall window: the card goes under the choices */
.evs-panel .col { min-width: min(calc(var(--u) * 330), 90vw); }
.evs-panel h2 { font: italic 400 max(21px, calc(var(--u) * 33))/1.15 var(--serif); letter-spacing: .005em; color: var(--ivory); text-shadow: var(--shade);
  padding-bottom: calc(var(--u) * 18); margin-bottom: calc(var(--u) * 18); border-bottom: var(--hair) solid rgba(207,181,124,.32); }
.evs-pause .evs-list, .evs-ask .evs-list { align-items: flex-start; }
.evs-pause .evs-list .it, .evs-ask .evs-list .it { padding-left: calc(var(--u) * 30); padding-right: calc(var(--u) * 12); }
.evs-pause .evs-list .it::after, .evs-ask .evs-list .it::after { display: none; }
.evs-ask .note { font-size: max(14px, calc(var(--u) * 19)); color: var(--ivory-2); margin: calc(var(--u) * -4) 0 calc(var(--u) * 20); text-shadow: var(--shade); }

.evs-card { padding-left: calc(var(--u) * 76); border-left: var(--hair) solid rgba(207,181,124,.24); }
.evs-card table { border-collapse: collapse; font: 500 max(12px, calc(var(--u) * 15))/1.2 var(--sans); color: var(--ivory-2); }
.evs-card th { font: 500 .82em/1 var(--sans); letter-spacing: .15em; text-align: left; color: var(--ivory-3); padding: 0 calc(var(--u) * 34) calc(var(--u) * 14) 0; white-space: nowrap; transition: opacity .3s ease; }
.evs-card td { padding: calc(var(--u) * 6) calc(var(--u) * 34) calc(var(--u) * 6) 0; white-space: nowrap; vertical-align: middle; transition: opacity .3s ease; }
.evs-card td:first-child { font: 400 max(13px, calc(var(--u) * 17.5))/1.2 var(--serif); color: var(--ivory); padding-right: calc(var(--u) * 46); }
.evs-card em { font: italic 400 .95em/1 var(--serif); margin: 0 .6em; color: var(--ivory-3); }
.evs-menus[data-device="keys"] .evs-card .p, .evs-menus[data-device="pad"] .evs-card .k { opacity: .58; }

.evs-options .col { width: min(calc(var(--u) * 720), 92vw); }
.evs-rows { display: flex; flex-direction: column; gap: calc(var(--u) * 1); }
.evs-rows .it { display: grid; grid-template-columns: minmax(0, 1fr) calc(var(--u) * 310); align-items: center; column-gap: calc(var(--u) * 24);
  padding: calc(var(--u) * 9) calc(var(--u) * 6) calc(var(--u) * 9) calc(var(--u) * 30); font-size: max(15px, calc(var(--u) * 21)); line-height: 1.25; }
.evs-rows .it.slider { grid-template-columns: minmax(0, 1fr) calc(var(--u) * 250) calc(var(--u) * 36); }
.evs-rows .it.act { margin-top: calc(var(--u) * 18); }
.evs-rows .sl { position: relative; height: calc(var(--u) * 28); --v: 0; }
.evs-rows .sl::before { content: ''; position: absolute; left: 0; right: 0; top: 50%; height: var(--hair); margin-top: calc(var(--hair) * -.5); background: rgba(207,181,124,.36); }
.evs-rows .sl .fl { position: absolute; left: 0; right: 0; top: 50%; height: max(2px, calc(var(--u) * 2)); margin-top: min(-1px, calc(var(--u) * -1)); background: var(--brass); transform-origin: 0 50%; transform: scaleX(var(--v)); }
.evs-rows .sl .kw { position: absolute; inset: 0; transform: translateX(calc(var(--v) * 100%)); pointer-events: none; }
.evs-rows .sl .kn { position: absolute; left: calc(var(--u) * -7); top: 50%; width: calc(var(--u) * 14); height: calc(var(--u) * 14); margin-top: calc(var(--u) * -7); background: var(--ivory-2); clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); }
.evs-rows .it.on .sl .fl { background: var(--gold); }
.evs-rows .it.on .sl .kn { background: #fff6e0; }
.evs-rows .val { text-align: right; font: 500 .78em/1 var(--sans); font-variant-numeric: lining-nums tabular-nums; letter-spacing: .03em; color: var(--ivory-3); text-shadow: none; }
.evs-rows .it.on .val { color: var(--ivory); }
.evs-rows .ch { display: flex; gap: calc(var(--u) * 24); }
.evs-rows .ch b { font-size: .9em; color: var(--ivory-3); padding-bottom: calc(var(--u) * 2); border-bottom: var(--hair) solid transparent; transition: color .15s ease, border-color .15s ease; }
.evs-rows .ch b.cur { color: var(--ivory-2); border-bottom-color: rgba(207,181,124,.5); }
.evs-rows .it.on .ch b.cur { color: var(--gold); border-bottom-color: var(--gold); }

/* the end card: the picture goes to black (the game does that) and the name stands in the middle of it, as large as on
   the loading screen; a line of thanks and the way back come up under it a few seconds later */
.evs-end .logo { position: absolute; left: 50%; top: 50%; width: min(calc(var(--u) * 960), 82vw); transform: translate(-50%, -50%); opacity: 0; transition: opacity .3s ease; }
.evs-end.cur .logo { opacity: 1; transition: opacity 2.4s ease .9s; }
.evs-end.cur .ink .flame { animation: evs-flicker 4.3s ease-in-out infinite; filter: drop-shadow(0 0 calc(var(--u) * 10) rgba(241,170,70,.6)); }
.evs-end .thanks { position: absolute; left: 0; right: 0; bottom: calc(var(--u) * 232); text-align: center; margin: 0; font: italic 400 max(15px, calc(var(--u) * 20))/1.3 var(--serif); color: var(--ivory-2); text-shadow: var(--shade); opacity: 0; transition: opacity .3s ease; }
.evs-end .evs-list { position: absolute; left: 50%; bottom: calc(var(--u) * 150); transform: translateX(-50%); opacity: 0; transition: opacity .3s ease; }
.evs-end.cur .thanks { opacity: 1; transition: opacity 1.4s ease 5.6s; }
.evs-end.cur .evs-list { opacity: 1; transition: opacity 1.4s ease 6.4s; }

/* ---------------------------------------------------------------- the notch and the home bar
   The page reaches under them (viewport-fit=cover); everything that stands at an edge is moved in by the browser's
   own measure. On a desk these are all 0 and nothing moves. (dev: &safe=l,t,r,b sets them, for pictures.) */
.evs { --sl: env(safe-area-inset-left, 0px); --sr: env(safe-area-inset-right, 0px); --st: env(safe-area-inset-top, 0px); --sb: env(safe-area-inset-bottom, 0px);
  --tu: clamp(.74px, .2564vh, 1.2px);                         /* the touch controls' unit: one pixel on a screen 390 high. A thumb is the same size on every phone, so it scales little; under 390 it must shrink for the buttons to fit below the pause mark (a browser's bar can leave 300) */
  --el: max(var(--sl), calc(var(--tu) * 12)); --er: max(var(--sr), calc(var(--tu) * 12));      /* the side edges as the thumbs' controls count them: a screen without a notch still keeps them 12 in, where a thumb's pad lands */
  touch-action: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }
.evs-vit { left: calc(max(16px, var(--u) * 40) + var(--sl)); top: calc(max(14px, var(--u) * 34) + var(--st)); }
.evs-flasks { left: calc(max(16px, var(--u) * 46) + var(--sl)); bottom: calc(max(14px, var(--u) * 38) + var(--sb)); }
.evs-boss { bottom: calc(max(20px, var(--u) * 52) + var(--sb)); }
.evs-name { bottom: calc(var(--bar) + 6.5vh + var(--sb)); }
.evs-sub { bottom: calc(max(var(--u) * 50, var(--bar) * .5) + var(--sb)); }
.evs-skip { right: calc(max(16px, var(--u) * 44) + var(--sr)); bottom: calc(max(var(--u) * 34, var(--bar) * .5) + var(--sb)); }
.evs-legend, .evs-keys { bottom: calc(max(12px, var(--u) * 28) + var(--sb)); padding: 0 calc(4vw + var(--sr)) 0 calc(4vw + var(--sl)); }
.evs-pause, .evs-ask, .evs-options { padding: calc(4vh + var(--st)) calc(5vw + var(--sr)) calc(9vh + var(--sb)) calc(5vw + var(--sl)); }
.evs { --title-x: clamp(calc(var(--logo-w) / 2 + 5vw + var(--sl)), 32vw, 50vw); }

/* ---------------------------------------------------------------- the controls shown when play begins (keys and gamepad)
   A column at the left edge, between his bars and his flasks, away from the two fighters. It comes by itself, stands
   about ten seconds and goes (ui.js); on touch the controls on the screen carry their own labels instead. */
.evs-ctl { position: absolute; left: calc(max(16px, var(--u) * 46) + var(--sl)); top: 41%; transform: translateY(-50%); opacity: 0; }
.evs-ctl::before { content: ''; position: absolute; inset: calc(var(--u) * -46) calc(var(--u) * -90) calc(var(--u) * -46) calc(var(--u) * -46); z-index: -1;
  background: radial-gradient(closest-side, rgba(5,7,11,.58), rgba(5,7,11,.36) 55%, rgba(5,7,11,0)); }
.evs-ctl h3 { font: italic 400 max(15px, calc(var(--u) * 21))/1.15 var(--serif); letter-spacing: .005em; color: var(--ivory); text-shadow: var(--shade);
  padding-bottom: calc(var(--u) * 11); margin-bottom: calc(var(--u) * 11); border-bottom: var(--hair) solid rgba(207,181,124,.32); }
.evs-ctl .r { display: grid; grid-template-columns: calc(var(--u) * 100) auto; column-gap: calc(var(--u) * 20); align-items: center; min-height: max(23px, calc(var(--u) * 31));
  font: 400 max(12.5px, calc(var(--u) * 16.5))/1.2 var(--serif); color: var(--ivory); text-shadow: var(--shade); white-space: nowrap; }
.evs-ctl .r .k { justify-self: end; display: inline-flex; font: 500 max(11.5px, calc(var(--u) * 14.5))/1 var(--sans); }

/* ---------------------------------------------------------------- touch: the marks of the controls, small (legends, the pause card, prompts) */
.evs-t { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 2em; height: 2em; vertical-align: middle; border-radius: 50%;
  border: var(--hair) solid rgba(207,181,124,.6); background: rgba(5,7,11,.52); color: var(--ivory); }
.evs-t svg { width: 60%; height: 60%; }
.evs-t.evs-tn { border-color: transparent; background: none; }
.evs-t.evs-tn svg { width: 92%; height: 92%; }
.evs-t.evs-tf svg { width: auto; height: 64%; }
.evs-i-t .s { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.evs-i-t .s.w { stroke-width: 1.9; }
.evs-i-t .d { fill: rgba(5,7,11,.4); stroke: currentColor; stroke-width: 1.3; stroke-linejoin: round; }
.evs-i-t .f { fill: currentColor; }
.evs-i-t .a { fill: var(--gold); }

/* ---------------------------------------------------------------- touch: the controls on the screen (src/ui/touch.js)
   Fine brass rings on the dark, ivory marks, dim at rest and lit under a finger. Sizes are in --tu. Nothing here is
   ever the target of a pointer: the fingers are read on the window. */
.evs-touch { position: absolute; inset: 0; opacity: 0; visibility: hidden; transition: opacity .25s ease, visibility 0s .25s; }
.evs-touch.on { opacity: 1; visibility: visible; transition: opacity .6s ease .2s, visibility 0s; }
.evs-tb { position: absolute; right: calc(var(--er) + var(--tu) * (var(--x) - var(--d) / 2)); bottom: calc(var(--sb) + var(--tu) * (var(--y) - var(--d) / 2));
  width: calc(var(--tu) * var(--d)); height: calc(var(--tu) * var(--d)); border-radius: 50%; color: rgba(236,227,205,.78);
  background: radial-gradient(closest-side, rgba(5,7,11,.52), rgba(5,7,11,.36) 76%, rgba(5,7,11,.2));
  box-shadow: inset 0 0 0 var(--hair) rgba(207,181,124,.5), 0 0 calc(var(--tu) * 12) rgba(0,0,0,.4);
  transition: box-shadow .2s ease, color .2s ease, transform .14s ease; }
.evs-tb > svg { position: absolute; left: 50%; top: 50%; width: 50%; height: 50%; transform: translate(-50%, -50%); filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.75)); }
.evs-tb.attack::before { content: ''; position: absolute; inset: calc(var(--tu) * 5); border-radius: 50%; box-shadow: inset 0 0 0 var(--hair) rgba(207,181,124,.26); }
.evs-tb.attack > svg { width: 47%; height: 47%; }
.evs-tb.heal > svg { width: auto; height: 50%; }
.evs-tb.heal .ct { position: absolute; right: 13%; bottom: 11%; font: 600 max(10.5px, calc(var(--tu) * 11.5))/1 var(--sans); font-variant-numeric: lining-nums; color: var(--ivory); text-shadow: 0 1px 2px #000; }
.evs-tb.heal.used .evs-i-flask .q { transform: scaleY(0); opacity: 0; }
.evs-tb.heal.used .evs-i-flask .g { stroke: rgba(207,181,124,.4); }
.evs-tb.lock.lit { color: var(--gold); box-shadow: inset 0 0 0 var(--hair) rgba(236,217,162,.8), 0 0 calc(var(--tu) * 12) rgba(0,0,0,.4); }
.evs-tb.pause { right: calc(var(--sr) + var(--tu) * 20); top: calc(var(--st) + var(--tu) * 16); bottom: auto; width: calc(var(--tu) * 40); height: calc(var(--tu) * 40);
  background: rgba(5,7,11,.3); box-shadow: inset 0 0 0 var(--hair) rgba(207,181,124,.36); color: rgba(236,227,205,.7); }
.evs-tb.dn, .evs-tb.lock.lit.dn { color: #fff6e0; transform: scale(.95); transition: box-shadow .05s ease, color .05s ease, transform .06s ease;
  background: radial-gradient(closest-side, rgba(236,217,162,.24), rgba(236,217,162,.11) 72%, rgba(5,7,11,.3));
  box-shadow: inset 0 0 0 calc(var(--hair) * 1.6) var(--gold), 0 0 calc(var(--tu) * 18) rgba(236,217,162,.3); }

/* the stick: a faint ring where it rests; under the thumb it is wherever the thumb put it */
.evs-ts { position: absolute; left: calc(var(--el) + var(--tu) * 48); bottom: calc(var(--sb) + var(--tu) * 40); width: calc(var(--tu) * 112); height: calc(var(--tu) * 112); border-radius: 50%;
  background: radial-gradient(closest-side, rgba(5,7,11,0) 50%, rgba(5,7,11,.3)); box-shadow: inset 0 0 0 var(--hair) rgba(207,181,124,.32); opacity: .62;
  will-change: transform; transition: opacity .3s ease, transform .16s ease-out; }
.evs-ts .tk { position: absolute; left: 50%; top: 50%; width: calc(var(--tu) * 5); height: calc(var(--tu) * 7); margin: calc(var(--tu) * -3.5) 0 0 calc(var(--tu) * -2.5);
  background: rgba(207,181,124,.6); clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); }
.evs-ts .tk:nth-child(1) { transform: translateY(calc(var(--tu) * -48)); }
.evs-ts .tk:nth-child(2) { transform: translateX(calc(var(--tu) * 48)) rotate(90deg); }
.evs-ts .tk:nth-child(3) { transform: translateY(calc(var(--tu) * 48)); }
.evs-ts .tk:nth-child(4) { transform: translateX(calc(var(--tu) * -48)) rotate(90deg); }
.evs-ts .kn { position: absolute; left: 50%; top: 50%; width: calc(var(--tu) * 46); height: calc(var(--tu) * 46); margin: calc(var(--tu) * -23) 0 0 calc(var(--tu) * -23); border-radius: 50%;
  background: radial-gradient(closest-side, rgba(5,7,11,.55), rgba(5,7,11,.4)); box-shadow: inset 0 0 0 var(--hair) rgba(207,181,124,.55);
  will-change: transform; transition: transform .16s ease-out, box-shadow .2s ease; }
.evs-ts .kn i { position: absolute; left: 50%; top: 50%; width: calc(var(--tu) * 8); height: calc(var(--tu) * 12); margin: calc(var(--tu) * -6) 0 0 calc(var(--tu) * -4);
  background: rgba(236,227,205,.62); clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); }
.evs-ts.dn { opacity: 1; transition: opacity .08s ease; }
.evs-ts.dn .kn { transition: box-shadow .08s ease; box-shadow: inset 0 0 0 calc(var(--hair) * 1.6) var(--gold), 0 0 calc(var(--tu) * 16) rgba(236,217,162,.28); }
.evs-ts.dn .kn i { background: #fff6e0; }

/* the first seconds: every control says what it is, and one line for the two thumbs under his bars */
.evs-tb .lb, .evs-ts .lb { position: absolute; left: 50%; top: calc(100% + var(--tu) * 4); transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: calc(var(--tu) * 2); white-space: nowrap;
  font: 500 max(10.5px, calc(var(--tu) * 11.5))/1 var(--sans); letter-spacing: .07em; color: var(--ivory); text-shadow: 0 1px 2px rgba(0,0,0,.95), 0 0 calc(var(--tu) * 7) rgba(0,0,0,.85); opacity: 0; transition: opacity .5s ease; }
.evs-tb .lb em { font-size: .87em; letter-spacing: .05em; color: var(--ivory-2); }
.evs-tb.pause .lb { left: auto; right: calc(100% + var(--tu) * 9); top: 50%; transform: translateY(-50%); }
.evs-tcap { position: absolute; left: calc(max(16px, var(--u) * 40) + var(--sl)); top: calc(max(14px, var(--u) * 34) + var(--st) + var(--u) * 42 + 13px); white-space: nowrap;
  font: 500 max(11px, calc(var(--tu) * 12))/1.2 var(--sans); letter-spacing: .06em; color: var(--ivory-2); text-shadow: var(--shade); opacity: 0; transition: opacity .5s ease; }
.evs-touch.lbl .lb, .evs-touch.lbl .evs-tcap { opacity: 1; }

/* ---------------------------------------------------------------- touch: what else changes while fingers are the device in hand */
/* his flasks are on their button; her bar keeps between the stick and the buttons */
.evs[data-input="touch"] .evs-flasks { display: none; }
.evs[data-input="touch"] .evs-boss { width: min(calc(var(--u) * 860), 72vw, calc(100vw - 2 * (var(--tu) * 236 + max(var(--el), var(--er))))); container-type: inline-size; }
.evs[data-input="touch"] .evs-boss .head { gap: 12px; }
/* (between a notch and the buttons the bar can be 260 px: her name is set a little smaller there so that it stays whole) */
.evs[data-input="touch"] .evs-boss .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: clamp(11.5px, 4.75cqw, max(14px, calc(var(--u) * 20))); padding: 8px 10px; margin: -8px -10px; }
/* a cutscene: the skip ring is the thing to hold */
.evs[data-input="touch"] .evs-skip { flex-direction: row-reverse; gap: 12px; bottom: calc(var(--sb) + var(--tu) * 108); font-size: max(12px, calc(var(--tu) * 13)); }      /* (above the lines where subtitles and her name stand: on a phone a long one reaches the corner) */
.evs[data-input="touch"] .evs-skip .evs-i-ring { width: calc(var(--tu) * 46); height: calc(var(--tu) * 46); }
.evs[data-input="touch"] .evs-skip .evs-i-ring .t { stroke-width: .75; stroke: rgba(207,181,124,.6); }
.evs[data-input="touch"] .evs-skip .evs-i-ring .v { stroke-width: 1.3; }
.evs-skip.dn { color: var(--ivory); }
.evs-skip.dn .evs-i-ring .t { fill: rgba(236,217,162,.16); stroke: rgba(236,217,162,.8); }
/* the screens with choices: every line a finger's width, no small print about keys */
.evs[data-input="touch"] .evs-keys { display: none; }
.evs[data-input="touch"] .evs-list { gap: 0; }
.evs[data-input="touch"] .evs-list .it { display: flex; align-items: center; min-height: 46px; padding-top: 0; padding-bottom: 0; }
.evs[data-input="touch"] .evs-rows .it { min-height: 46px; padding-top: 0; padding-bottom: 0; }
.evs[data-input="touch"] .evs-rows .sl { height: 42px; }
.evs[data-input="touch"] .evs-rows .ch { gap: calc(var(--u) * 6); }
.evs[data-input="touch"] .evs-rows .ch b { padding: 14px 9px 13px; border-bottom-width: 0; background: linear-gradient(transparent, transparent) no-repeat 50% calc(100% - 10px) / calc(100% - 18px) var(--hair); }
.evs[data-input="touch"] .evs-rows .ch b.cur { background-image: linear-gradient(rgba(207,181,124,.5), rgba(207,181,124,.5)); }
.evs[data-input="touch"] .evs-rows .it.on .ch b.cur { background-image: linear-gradient(var(--gold), var(--gold)); }
.evs[data-input="touch"] .evs-pause, .evs[data-input="touch"] .evs-ask, .evs[data-input="touch"] .evs-options { padding-bottom: calc(4vh + var(--sb)); }
/* the pause card: one column, the controls as they are on the screen */
.evs-card .t { display: none; }
.evs-menus[data-device="touch"] .evs-card .k, .evs-menus[data-device="touch"] .evs-card .p { display: none; }
.evs-menus[data-device="touch"] .evs-card .t { display: table-cell; }
.evs-card td.t span { margin-left: .7em; color: var(--ivory-3); letter-spacing: .05em; }

/* the title: on a small screen the interface's unit stops shrinking (so that type stays readable) and the logo, 740
   units wide, grew to three fifths of a phone's width and lay over the Cantor. With fingers it keeps the share of the
   width it has at 1600 x 900 */
.evs[data-input="touch"] { --logo-w: min(calc(var(--u) * 740), 46.25vw); }
/* a phone lying on its side: little height. The title's choices keep clear of the logo; the options stand in two columns */
@media (max-height: 520px) {
  .evs[data-input="touch"] .evs-title .evs-spot { bottom: calc(var(--u) * 222 + 22px + var(--sb)); }
  .evs[data-input="touch"] .evs-title .evs-list { bottom: calc(var(--u) * 92 + var(--sb)); }
  .evs[data-input="touch"] .evs-pause, .evs[data-input="touch"] .evs-ask, .evs[data-input="touch"] .evs-options { gap: 10px 28px; padding: calc(2vh + var(--st)) calc(3vw + var(--sr)) calc(2vh + var(--sb)) calc(3vw + var(--sl)); }
  .evs[data-input="touch"] .evs-panel h2 { padding-bottom: 9px; margin-bottom: 7px; }
  /* the pause: the choices and the card side by side in what a notch leaves of 852 px (about 680) */
  .evs[data-input="touch"] .evs-pause .col { min-width: 0; }
  .evs[data-input="touch"] .evs-card { padding-left: 22px; }
  .evs[data-input="touch"] .evs-card td { padding-top: 2px; padding-bottom: 2px; }
  .evs[data-input="touch"] .evs-card td:first-child { padding-right: 16px; }
  .evs[data-input="touch"] .evs-card .t { padding-right: 0; }
  .evs[data-input="touch"] .evs-card th { padding-bottom: 6px; }
  /* the options: sliders on the left, choices and the way back on the right */
  .evs[data-input="touch"] .evs-options .col { width: 100%; max-width: 760px; }
  .evs[data-input="touch"] .evs-rows { display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); grid-template-rows: repeat(4, auto); grid-auto-flow: column; column-gap: 18px; }
  .evs[data-input="touch"] .evs-rows .it { grid-template-columns: minmax(0, 1fr) auto; column-gap: 10px; padding-left: 24px; padding-right: 0; }
  .evs[data-input="touch"] .evs-rows .it.slider { grid-template-columns: minmax(0, 1fr) 88px 28px; }
  .evs[data-input="touch"] .evs-rows .it.act { margin-top: 0; }
  .evs[data-input="touch"] .evs-rows .ch { gap: 0; }
  .evs[data-input="touch"] .evs-rows .ch b { padding-left: 8px; padding-right: 8px; background-size: calc(100% - 16px) var(--hair); }
  /* the end card: the name smaller, the thanks and the way back under it (at this height they stood on the letters) */
  .evs[data-input="touch"] .evs-end .logo { width: min(calc(var(--u) * 960), 60vw); top: 42%; }
  .evs[data-input="touch"] .evs-end .thanks { bottom: calc(var(--sb) + 22px + 46px + 8px); }
  .evs[data-input="touch"] .evs-end .evs-list { bottom: calc(var(--sb) + 22px); }
}

/* ---------------------------------------------------------------- an upright phone: a card asks for it to be turned (the fight is paused behind it) */
.evs-turn { position: absolute; inset: 0; z-index: 5; display: none; align-items: center; justify-content: center; text-align: center; pointer-events: auto;
  background: radial-gradient(120% 80% at 50% 46%, rgba(5,7,11,.965) 0%, rgba(3,4,7,.99) 100%); }
.evs.upright .evs-turn { display: flex; }
.evs-turn .in { display: flex; flex-direction: column; align-items: center; padding: 0 9vw; }
.evs-i-turn { width: 104px; height: 78px; margin-bottom: 26px; }
.evs-i-turn .p { fill: none; stroke: rgba(207,181,124,.3); stroke-width: 1.1; }
.evs-i-turn .l { fill: rgba(236,217,162,.06); stroke: var(--brass); stroke-width: 1.2; }
.evs-i-turn .s { fill: none; stroke: var(--ivory-2); stroke-width: 1.1; stroke-linecap: round; }
.evs-i-turn .f { fill: var(--ivory-2); }
.evs-turn .a { font: italic 400 22px/1.25 var(--serif); color: var(--ivory); text-shadow: var(--shade); }
.evs-turn .b { margin-top: 12px; font: 500 12.5px/1.3 var(--sans); letter-spacing: .08em; color: var(--ivory-3); }

/* ---------------------------------------------------------------- motion */
@keyframes evs-flicker {
  0%, 100% { transform: scale(1, 1) skewX(0deg); } 17% { transform: scale(.975, 1.035) skewX(-1.6deg); } 36% { transform: scale(1.02, .975) skewX(1deg); }
  55% { transform: scale(.985, 1.03) skewX(-.6deg); } 71% { transform: scale(1.012, .99) skewX(1.5deg); } 88% { transform: scale(.99, 1.02) skewX(-.9deg); }
}
@keyframes evs-gutter {
  0%, 100% { opacity: .9; } 18% { opacity: .5; } 31% { opacity: .82; } 47% { opacity: .42; } 62% { opacity: .78; } 80% { opacity: .55; }
}
@keyframes evs-low {
  0%, 100% { box-shadow: 0 0 0 var(--hair) rgba(207,181,124,.5), 0 0 0 calc(var(--hair) * 2) rgba(0,0,0,.4), 0 calc(var(--u) * 2) calc(var(--u) * 10) rgba(0,0,0,.5); }
  50% { box-shadow: 0 0 0 var(--hair) rgba(214,120,96,.75), 0 0 0 calc(var(--hair) * 2) rgba(0,0,0,.4), 0 0 calc(var(--u) * 12) rgba(170,40,28,.5); }
}
/* the picture tools' browser: no time passes there, so every screen is shown settled (see devhold.js) */
.evs.still *, .evs.still *::before, .evs.still *::after { transition: none !important; animation: none !important; }
/* reduced motion (the option, which follows the system's setting until the player chooses): fades stay, nothing travels or pulses */
.evs.rm *, .evs.rm *::before, .evs.rm *::after { animation: none !important; }
.evs.rm .evs-lock span { transform: none; }
.evs.rm .evs-list .it::before, .evs.rm .evs-list .it::after, .evs.rm .evs-rows .it::before { transform: none; }
.evs.rm .evs-i-flask .q { transition: opacity .5s ease; }
.evs.rm .evs-tb.dn { transform: none; }
`;

let node = null, users = 0;
export function installStyle() {
  if (users++ === 0) { node = document.createElement('style'); node.setAttribute('data-evs', ''); node.textContent = CSS; document.head.appendChild(node); }
}
export function removeStyle() {
  if (users > 0 && --users === 0 && node) { node.remove(); node = null; }
}
