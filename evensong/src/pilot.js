// Being played from outside (&pilot=<session>): the game stands still until tools/pilot.py sends a command, then runs
// that many milliseconds with those buttons held, and answers with what a player would know: a picture of the screen
// and the numbers on the interface. Whoever plays decides a fraction of a second at a time, through the same controls
// a person has (stick, camera, buttons). Every step's inputs are logged, so the session can be replayed exactly at
// full speed and filmed (tools/pilot.py replay). This is not the test bot (src/bot.js): nothing here decides anything.
// The log also says under which numbers of difficulty the session was played (`rules`, src/core/rules.js): the
// capture asks for exactly those, so a session stays the same fight after the game's own numbers change.
//
// A command (JSON written by tools/pilot.py): { id, ms, hold: ['fwd','left','block',...], tap: [{ a: 'roll', at: ms }],
//   look: [yaw, pitch] (radians over the whole slice), shot: false to skip the picture, quit: true }
// fwd / back / left / right push the stick; the rest are the game's actions (attack heavy block roll heal lock ...).
import * as THREE from 'three';

const MOVES = { fwd: [0, 1], back: [0, -1], left: [-1, 0], right: [1, 0] };
const ACTIONS = ['attack', 'heavy', 'block', 'roll', 'heal', 'lock', 'pause', 'confirm', 'skip'];
const DEG = 180 / Math.PI, r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
const wrap = (a) => { a = ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return a; };

/** Where things stand at a step (exact numbers: a replay must reproduce them to the last digit). */
export function checkpoint(game, s) { const p = game.ctx.player, b = game.ctx.boss; return [s, p.hp, b.hp, p.pos.x, p.pos.z, b.pos.x, b.pos.z]; }

/**
 * Replay a pilot session's log exactly: every game step gets the inputs it had, by its own number, whatever the frame
 * rate. game.replayDone turns true after the last logged step; game.replayDiff holds the first checkpoint that did not
 * match (null if the fight is the same fight).
 */
export function installReplay(game, log) {
  const input = game.ctx.input, map = new Map(log.steps.map((e) => [e[0], e])), last = log.steps.length ? log.steps[log.steps.length - 1][0] : 0;
  const checks = new Map((log.checks || []).map((c) => [c[0], c]));
  input.enabled = false; game.replayDone = false; game.replayDiff = null; game.replayLast = last;
  const upd = input.update.bind(input);
  input.update = () => {
    const done = Math.round(game.time * 60), k = done + 1, e = map.get(k);
    const c = checks.get(done);
    if (c && !game.replayDiff) { const now = checkpoint(game, done); if (now.some((v, i) => Math.abs(v - c[i]) > 1e-9)) { game.replayDiff = { step: done, logged: c, now }; console.error('replay: not the same fight at step ' + done + ': logged ' + JSON.stringify(c) + ' now ' + JSON.stringify(now)); } }
    if (e) { input.setMove(e[1], e[2]); input.setLook(e[3], e[4]); ACTIONS.forEach((a, bit) => input.set(a, !!(e[5] & (1 << bit)))); }
    else { input.setMove(0, 0); input.setLook(0, 0); for (const a of ACTIONS) input.set(a, false); if (k > last) game.replayDone = true; }
    upd();
  };
}

export async function runPilot(game, params) {
  const sess = params.get('pilot') || 'x', ctx = game.ctx, input = ctx.input, loop = game.loop, bus = ctx.bus;
  const post = (name, body) => fetch('/__shot/' + name, { method: 'POST', body });
  const grab = () => new Promise((r) => game.canvas.toBlob(r, 'image/jpeg', 0.82));
  input.enabled = false;
  let n = 0, lastMove = null, events = [];
  const steps = [];                                   // one entry per game step: [stepIndex, moveX, moveY, lookX, lookY, heldActionsBitmask]
  const checks = [];                                  // every half second: where things stood, so a replay can prove it is the same fight
  const stepIndex = () => Math.round(game.time * 60);
  bus.on('*', (name, d) => {
    if (name === 'hit') events.push(`${d.attacker === ctx.player ? 'you hit her' : 'she hit you'} for ${Math.round(d.damage || 0)}${d.blocked ? ' (blocked)' : ''}${d.fatal ? ' FATAL' : ''}`);
    else if (name === 'boss-move') { lastMove = d; events.push(`her ${d.name}: ${d.stage}`); }
    else if (name === 'state') events.push(`game: ${d.from} -> ${d.to}`);
    else if (['boss-slam', 'boss-stagger', 'boss-phase', 'boss-died', 'player-died', 'player-respawn', 'stamina-out', 'heal', 'roll'].includes(name)) events.push(name);
    else if (name === 'lock') events.push(d.on ? 'locked on' : 'lock released');
    else if (name === 'cine') events.push(`cutscene ${d.name} ${d.on ? 'begins' : 'ends'}`);
  });
  const _d = new THREE.Vector3();
  const observe = () => {
    const p = ctx.player, b = ctx.boss, cam = ctx.camera;
    cam.getWorldDirection(_d); const camYaw = Math.atan2(_d.x, _d.z);
    const dx = b.pos.x - p.pos.x, dz = b.pos.z - p.pos.z, dist = Math.hypot(dx, dz), toHer = Math.atan2(dx, dz);
    const side = (a) => { const d = Math.round(wrap(a) * DEG); return d === 0 ? 'dead ahead' : `${Math.abs(d)} deg to the ${d > 0 ? 'left' : 'right'}`; };
    return {
      t: r2(game.time), step: stepIndex(), state: game.state, cutscene: ctx.cine.playing ? `${ctx.cine.name} ${r1(ctx.cine.time)}/${r1(ctx.cine.duration)}` : null,
      you: { hp: Math.round(p.hp), hpMax: p.hpMax, stamina: Math.round(p.stamina), flasks: p.flasks, state: p.state, locked: !!p.locked, x: r1(p.pos.x), z: r1(p.pos.z) },
      her: { hp: Math.round(b.hp), hpMax: b.hpMax, phase: b.phase, state: b.state, move: lastMove ? `${lastMove.name} (${lastMove.stage})` : null, staggered: !!b.staggered, x: r1(b.pos.x), z: r1(b.pos.z) },
      distance: r1(dist), herFromCamera: side(toHer - camYaw), herFromYourFacing: side(toHer - p.yaw), sheFacesYou: Math.abs(wrap(Math.atan2(-dx, -dz) - b.yaw)) < 0.6,
      candles: r2(ctx.candles.lit), events,
    };
  };
  loop.advance(0);
  await post(`pilot_${sess}_obs.json`, JSON.stringify({ id: 0, ...observe() })); await post(`pilot_${sess}_obs.jpg`, await grab()); await post(`pilot_${sess}_done_0.txt`, 'ok');
  for (;;) {
    let cmd; try { cmd = await (await fetch(`/__pilot/next?s=${sess}&after=${n}`)).json(); } catch (e) { await new Promise((r) => setTimeout(r, 300)); continue; }
    if (!cmd || !cmd.id) continue;
    n = cmd.id; events = [];
    if (cmd.quit) { await post(`pilot_${sess}_log.json`, JSON.stringify({ seed: game.seed, url: location.search, rules: ctx.player.rules, steps, checks })); await post(`pilot_${sess}_done_${n}.txt`, 'quit'); document.title = 'pilot done'; return; }
    const frames = Math.max(1, Math.round((cmd.ms || 250) * 60 / 1000)), held = new Set(cmd.hold || []), taps = cmd.tap || [], look = cmd.look || [0, 0];
    let prevStep = stepIndex();
    for (let i = 0; i < frames; i++) {
      let mx = 0, my = 0; for (const k in MOVES) if (held.has(k)) { mx += MOVES[k][0]; my += MOVES[k][1]; }
      const now = i * 1000 / 60; let mask = 0;
      ACTIONS.forEach((a, bit) => { const on = held.has(a) || taps.some((t) => t.a === a && now >= (t.at || 0) && now < (t.at || 0) + (t.ms || 90)); input.set(a, on); if (on) mask |= 1 << bit; });
      // the camera turn is eased over the slice (a hand moves a mouse in a curve, not a step)
      const u0 = i / frames, u1 = (i + 1) / frames, e = (u) => u * u * (3 - 2 * u), w = e(u1) - e(u0);
      const lx = look[0] * w, ly = look[1] * w;
      input.setMove(mx, my); input.setLook(lx, ly);
      game.drawFrames = i === frames - 1;
      loop.advance(1 / 60);
      const s = stepIndex(); if (s !== prevStep) { steps.push([s, mx, my, lx, ly, mask]); prevStep = s; if (s % 30 === 0) checks.push(checkpoint(game, s)); }
    }
    game.drawFrames = true; input.setLook(0, 0);
    await post(`pilot_${sess}_obs.json`, JSON.stringify({ id: n, ...observe() }));
    if (cmd.shot !== false) await post(`pilot_${sess}_obs.jpg`, await grab());
    if (n % 20 === 0) await post(`pilot_${sess}_log.json`, JSON.stringify({ seed: game.seed, url: location.search, rules: ctx.player.rules, steps, checks }));
    await post(`pilot_${sess}_done_${n}.txt`, 'ok');
  }
}
