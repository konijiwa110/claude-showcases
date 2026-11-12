// Development and testing: everything the page can be asked to do through its address.
//
//   ?dev                 no title screen: start where &at says (default: the fight)
//   &at=title|intro|fight|phase2|fight2|ending|dead
//                        where to start. intro, phase2 and ending are the three cutscenes; fight2 is phase two itself
//   &ct=12               run this many seconds of the game without drawing before anything else (to look at a
//                        moment of a cutscene: &at=intro&ct=31&t=0.1); everything is simulated, nothing is skipped
//   &q=low|medium|high|ultra
//   &god                 the pilgrim cannot be hurt        &php=30      his health
//   &bosshp=0.55         her health as a share             &noai        she stands still (she can still be hit)
//   &rules=film          the fight as hard as it was filmed (src/core/rules.js holds every number of difficulty)
//   &rule=health:160,rest:1.5      other numbers of difficulty for this run (the names are in src/core/rules.js)
//   &place=cantor:0,-4,0;knight:0,3,180       put a fighter somewhere: x, z, yaw in degrees
//   &anim=cantor:slash_combo:0.75,knight:roll  play one clip on a fighter over and over as a puppet (third field: speed);
//                        add &root=1 to let the clip's own travel move the fighter
//   &pose=cantor:slash_combo@0.8,knight:idle@0 hold one moment (seconds) of a clip
//   &cam=x,y,z,tx,ty,tz  a fixed camera looking from x,y,z at tx,ty,tz (metres); &fov=35;
//                        &camrel=knight|cantor makes both points relative to that fighter's feet
//   &ui=0                hide the interface
//   &grips=1             draw where Mixamo's own props sit in the hands (bright sticks; docs/grips.md); &grips=2 hides ours
//   &bright=3            multiply the exposure (to look at dark things closely)
//   &play=<script>       press buttons by script: "attack@0.2,roll@1,fwd@0-3,left@1-2,lock@0.1" (seconds; a bare time
//                        is a tap of a tenth of a second). fwd back left right push the stick.
//   &bot=1               a stand-in player fights (src/bot.js, when it exists)
//   &do=<things>         call a method or set a value at a moment, separated by semicolons. Paths start at ctx:
//                        &do=vfx.demo("sparks")@0.5;candles.snuffAll(2)@1;water.ripple(0,5,3)@0.2;boss.kit.wings.open=1@0
//                        (arguments and values are JSON; the time is seconds after the start)
//
// Pictures (tools/shot.py adds &shot itself):
//   &shot=name.png       run &t seconds of game time (default 1), then send one picture of the canvas to the dev server
//   &frames=8&dt=0.25    with &shot: that many pictures, dt seconds apart, and <name>_frames.json with what happened
//                        (seconds of the clock a player lives by: a hit-stop holds the world for its frames, so a strip
//                        across a blow shows the held moment; &nostop=1 runs through hit-stops as if they were not there)
//   &record=name&seconds=8&fps=30   with &shot: every frame as name_0001.jpg ... (tools/film.py makes the film)
//   &perf=name.json      time 240 frames and send the numbers
//   &replay=<log url>    play a pilot session's input log back exactly (inputs go to each step by its number)
//   &capture=video|audio with &replay: be filmed frame by frame, or record the sound in real time (tools/capture.py)
//   &pilot=name          be played from outside, a fraction of a second at a time: python3 tools/pilot.py (src/pilot.js)
//   &fight=name.json     play a whole fight as fast as the machine can, without drawing (use with &bot=1), until the
//                        Cantor is dead, the pilgrim has died &deaths=3 times, or &limit=420 seconds of game time
//                        have passed; then send a report: who hit whom and how often, her moves, deaths, times.
//                        python3 tools/fight.py runs several of these and prints a table. &seed=7 varies the fight.
//
// In a picture run the clock is driven from here, step by step, with no display involved: the result is the same on
// every run. Simulation must therefore live in update(dt); frame() is only for smoothing what is drawn.
const num = (p, k, d) => (p.has(k) && p.get(k) !== '' && !Number.isNaN(+p.get(k)) ? +p.get(k) : d);
const MOVES = { fwd: [0, 1], back: [0, -1], left: [-1, 0], right: [1, 0] };

export function startPoint(params) { return params.get('at') || 'fight'; }

export function parseScript(text) {
  const out = [];
  for (const part of (text || '').split(',')) {
    const m = part.trim().match(/^([a-z]+)@([\d.]+)(?:-([\d.]+))?$/i);
    if (m) out.push({ action: m[1], t0: +m[2], t1: m[3] !== undefined ? +m[3] : +m[2] + 0.1 });
  }
  return out;
}
function applyScript(input, script, t) {
  const want = {}; let mx = 0, my = 0, moved = false;
  for (const s of script) {
    const on = t >= s.t0 && t < s.t1;
    if (MOVES[s.action]) { moved = true; if (on) { mx += MOVES[s.action][0]; my += MOVES[s.action][1]; } } else want[s.action] = want[s.action] || on;
  }
  for (const a in want) input.set(a, want[a]);
  if (moved) input.setMove(mx, my);
}

/** "vfx.demo(\"sparks\")@0.5;boss.kit.wings.open=1@0" -> [{ path, args | value, t }] */
export function parseDo(text) {
  const out = [];
  for (const part of (text || '').split(';')) {
    const m = part.trim().match(/^([\w.$]+)(?:\((.*)\)|=(.+))?@([\d.]+)$/);
    if (!m) { if (part.trim()) console.error('&do: cannot read "' + part + '"'); continue; }
    out.push({ text: part.trim(), path: m[1].split('.'), args: m[2] !== undefined ? JSON.parse('[' + m[2] + ']') : null, value: m[3] !== undefined ? JSON.parse(m[3]) : undefined, t: +m[4] });
  }
  return out;
}
function runDo(ctx, d) {
  let o = ctx; const p = d.path;
  for (let i = 0; i < p.length - 1; i++) { o = o[p[i]]; if (o === undefined || o === null) throw new Error('nothing at ' + p.slice(0, i + 1).join('.')); }
  const k = p[p.length - 1];
  if (d.args) { if (typeof o[k] !== 'function') throw new Error(p.join('.') + ' is not a function'); o[k](...d.args); } else o[k] = d.value;
}

const who = (ctx, name) => (name === 'knight' || name === 'player' || name === 'pilgrim' ? ctx.player : ctx.boss);

export async function attach(game, params) {
  const ctx = game.ctx, shot = params.get('shot'), perf = params.get('perf'), fight = params.get('fight'), auto = !!(shot || perf || fight || params.has('pilot') || params.has('capture'));
  const canvas = game.canvas;
  const post = (name, body) => fetch('/__shot/' + name, { method: 'POST', body });
  const grab = (type = 'image/png', q) => new Promise((r) => canvas.toBlob(r, type, q));

  if (auto) ctx.input.enabled = false;
  game.begin(startPoint(params));
  if (params.get('ui') === '0') document.getElementById('ui').style.display = 'none';
  if (params.has('bright')) { const k = num(params, 'bright', 3); ctx.gfx.onBeforeRender(() => { ctx.gfx.post.exposure = k; }); }
  if (params.has('god')) ctx.player.god = true;
  if (params.has('php')) ctx.player.hp = num(params, 'php', 100);
  if (params.has('bosshp')) ctx.boss.hp = ctx.boss.hpMax * num(params, 'bosshp', 1);
  if (params.has('noai')) ctx.boss.ai = false;
  for (const part of (params.get('place') || '').split(';')) {
    const m = part.match(/^(\w+):(-?[\d.]+),(-?[\d.]+)(?:,(-?[\d.]+))?$/);
    if (m) { const f = who(ctx, m[1]); f.pos.set(+m[2], 0, +m[3]); if (m[4] !== undefined) f.yaw = (+m[4] * Math.PI) / 180; }
  }
  for (const part of (params.get('anim') || '').split(',')) {
    const [n, clip, speed] = part.split(':'); if (!clip) continue;
    const f = who(ctx, n); f.puppet = params.has('root') ? 'root' : true; f.char.play(clip, { loop: true, fade: 0, force: true, speed: +speed || 1 });
  }
  for (const part of (params.get('pose') || '').split(',')) {
    const m = part.match(/^(\w+):(\w+)@([\d.]+)$/); if (!m) continue;
    const f = who(ctx, m[1]); f.puppet = true; const a = f.char.play(m[2], { fade: 0, force: true, at: +m[3] }); if (a) a.paused = true;
  }
  if (params.has('grips')) await (await import('./dev_grips.js')).showGrips(ctx, params.get('grips') === '2');     // &grips=1: draw Mixamo's own holds as sticks; =2 also hides ours
  if (params.has('cam')) {
    const c = params.get('cam').split(',').map(Number), rel = params.get('camrel'), fov = num(params, 'fov', 0);
    game.cameraHook = (cam) => {
      const o = rel ? who(ctx, rel).pos : { x: 0, z: 0 };
      cam.position.set(c[0] + o.x, c[1], c[2] + o.z); cam.up.set(0, 1, 0); cam.lookAt((c[3] || 0) + o.x, c[4] || 0, (c[5] || 0) + o.z);
      if (fov && cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
      cam.updateMatrixWorld();
    };
  }
  const hooks = [], t0 = game.time;
  const script = parseScript(params.get('play'));
  if (script.length) hooks.push(() => applyScript(ctx.input, script, game.time - t0));
  if (params.has('bot')) { const bot = await import('./bot.js'); hooks.push(bot.attachBot(game, { skill: num(params, 'bot', 1) })); }
  const todo = parseDo(params.get('do'));
  if (todo.length) hooks.push(() => { const t = game.time - t0; for (const d of todo) if (!d.done && t >= d.t) { d.done = true; try { runDo(ctx, d); } catch (e) { console.error('&do failed: ' + d.text + ': ' + e.message); } } });
  if (hooks.length) game.beforeStep = (dt) => { for (const h of hooks) h(dt); };
  if (params.has('pilot')) { await (await import('./pilot.js')).runPilot(game, params); return true; }     // someone plays through tools/pilot.py
  if (params.has('replay')) { const log = await (await fetch(params.get('replay'))).json(); (await import('./pilot.js')).installReplay(game, log); }     // play a pilot session's log back exactly
  if (params.has('capture')) { await (await import('./capture.js')).runCapture(game, params); return true; }           // film it: tools/capture.py
  const ct = num(params, 'ct', 0);
  if (ct > 0) { game.drawFrames = false; for (let i = 0, n = Math.round(ct * 60); i < n; i++) { game.loop.freeze = 0; game.loop.advance(1 / 60); } game.drawFrames = true; }
  if (!auto) return false;                                    // an ordinary dev session: the real loop runs it

  // ---- a picture or a timing run: drive the clock from here
  const loop = game.loop, noStop = params.has('nostop');
  const advance = (seconds) => {
    const n = Math.max(0, Math.round(seconds * 60));
    // Hit-stop is honoured (a frozen moment takes its frames like any other, so a strip across a blow shows it); &nostop=1 skips it.
    for (let i = 0; i < n; i++) { if (noStop) loop.freeze = 0; game.drawFrames = i >= n - 6 || i % 6 === 0; loop.advance(1 / 60); }   // draw now and then, and the last few (for effects that settle over frames)
    game.drawFrames = true;
  };
  const state = () => {
    const p = ctx.player, b = ctx.boss, r = (v) => +v.toFixed(2);
    return { t: r(game.time), state: game.state, p: `${r(p.pos.x)},${r(p.pos.z)}`, pyaw: r(p.yaw), php: Math.round(p.hp), st: Math.round(p.stamina), ps: p.state, b: `${r(b.pos.x)},${r(b.pos.z)}`, bhp: Math.round(b.hp), bs: b.state, cine: ctx.cine.playing ? r(ctx.cine.time) : '-' };
  };
  if (fight) {
    const limit = num(params, 'limit', 420), maxDeaths = num(params, 'deaths', 3), r1 = (v) => +v.toFixed(1);
    const side = () => ({ hits: 0, damage: 0, blocked: 0 });
    const tally = { seed: game.seed, dealt: side(), taken: side(), moves: {}, deaths: [], phaseAt: null, staggers: 0, wonAt: null, rolls: 0, heals: 0, errors: [] };
    ctx.bus.on('hit', (h) => { const s = h.attacker === ctx.player ? tally.dealt : tally.taken; s.hits++; s.damage += h.damage || 0; if (h.blocked) s.blocked++; });
    ctx.bus.on('boss-move', (e) => { if (e.stage === 'windup') tally.moves[e.name] = (tally.moves[e.name] || 0) + 1; });
    ctx.bus.on('player-died', () => tally.deaths.push({ t: r1(game.time), bossHp: Math.round(ctx.boss.hp), phase: ctx.boss.phase }));
    ctx.bus.on('boss-phase', () => { if (tally.phaseAt === null) tally.phaseAt = r1(game.time); });
    ctx.bus.on('boss-stagger', () => tally.staggers++);
    ctx.bus.on('roll', () => tally.rolls++); ctx.bus.on('heal', () => tally.heals++);
    window.addEventListener('error', (e) => tally.errors.push(String(e.message)));
    game.drawFrames = false;
    for (let i = 0, n = Math.round(limit * 60); i < n; i++) {
      loop.freeze = 0; loop.advance(1 / 60);
      if (game.state === 'won' && !ctx.cine.playing) { tally.wonAt = r1(game.time); break; }
      if (tally.deaths.length >= maxDeaths) break;
      if (i % 900 === 899) await new Promise((r) => setTimeout(r, 0));          // let the browser breathe
    }
    game.drawFrames = true; loop.advance(0);
    tally.dealt.damage = Math.round(tally.dealt.damage); tally.taken.damage = Math.round(tally.taken.damage);
    await post(fight, JSON.stringify({ ...tally, ...state(), bot: game.botStats || null }, null, 1));
    if (shot) await post(shot, await grab());
    document.title = 'fight done';
    return true;
  }
  advance(num(params, 't', 1));
  if (perf) {
    const gl = ctx.gfx.renderer.getContext(), px = new Uint8Array(4), times = [];
    for (let i = 0; i < 240; i++) { const a = performance.now(); loop.freeze = 0; loop.advance(1 / 60); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); times.push(performance.now() - a); }
    times.sort((a, b) => a - b);
    const mem = performance.memory ? { jsHeapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) } : {};
    await post(perf, JSON.stringify({ avgMs: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2), medianMs: +times[120].toFixed(2), p95Ms: +times[228].toFixed(2), ...ctx.gfx.stats(), ...mem, ...state() }));
    document.title = 'perf done';
    return true;
  }
  loop.advance(0);
  await new Promise((r) => requestAnimationFrame(r));
  if (params.has('record')) {
    const base = params.get('record'), fps = num(params, 'fps', 30), n = Math.round(num(params, 'seconds', 6) * fps);
    for (let i = 1; i <= n; i++) { loop.freeze = 0; loop.advance(1 / fps); await post(`${base}_${String(i).padStart(4, '0')}.jpg`, await grab('image/jpeg', 0.93)); }
    await post(shot, await grab());
    document.title = 'shot done';
    return true;
  }
  const frames = Math.max(0, Math.min(24, num(params, 'frames', 0))), fdt = num(params, 'dt', 0.25);
  if (frames > 1) {
    const base = shot.replace(/\.\w+$/, ''), ext = (shot.match(/\.(\w+)$/) || [0, 'png'])[1], log = [];
    for (let i = 0; i < frames; i++) {
      if (i) { advance(fdt); loop.advance(0); }
      log.push(state());
      await post(`${base}_f${String(i).padStart(2, '0')}.${ext}`, await grab());
    }
    await post(base + '_frames.json', JSON.stringify({ dt: fdt, frames: log }));
  } else await post(shot, await grab());
  document.title = 'shot done';
  return true;
}
