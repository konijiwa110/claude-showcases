// Sound: which effect answers which event, and how each sits in the mix.
//
// Every effect is a recording (assets/audio/sfx/<name>_<take>.ogg) built by tools/sfx/; nothing here is made by an
// oscillator. Since 10 Nov the water, steel, wood and air (18 names: his steps, the roll, her steps, slam, tide, the
// hits, the block and the broken guard, the clash, the swings, the draw, her stagger) are cut from free recordings: the
// Sonniss GDC bundles and public-domain sounds from Freesound (tools/sfx/free.py; the chosen pieces are in
// tools/sfx/free_set.py, every file and its license in source-art/sfx/free/ledger.json). The drip is an ElevenLabs
// sound generation (tools/sfx/eleven.py): no free recording of one clean drop was found. The tuned sounds (her pipes,
// the rings, the bell, the flask, the interface, the candles, the room) are built from the CC0 percussion and orchestra
// libraries. The two sets before this one are kept: `&sfx=eleven` plays the set of 9 Nov (ElevenLabs generations),
// `&sfx=cc0` the first one. tools/sfx levels each take and writes its level into src/audio/manifest.js, so `trim` below
// is only a last touch by hand (1 = as leveled). docs/modules/sound.md lists what each one is made of and which sounds
// were left out.
//
//   trim    level against the leveled file (default 1)
//   wet     how much goes to the hall (0..1; default 0.3)
//   ref     meters from the listener within which it is at full level (default 9); beyond, it falls as ref / distance
//   gap     seconds: the same sound will not start twice within this (default 0.05)
//   jitter  +- change of speed from one playing to the next (default 0.05; play()'s own `jitter` overrides)
//   pri     when more than 24 sounds want to play, the least important and quietest go first (default 1)
//   ui      an interface sound: no place, no hall, heard under a pause
//   duck    [amount, seconds]: the music bows this much for this long when it plays

/** Sounds switched off without removing them: a name here (or &mute=name,name in the address) is never played. */
export const MUTED = new Set([]);

export const SOUNDS = {
  // ---- the pilgrim
  step_walk: { wet: 0.3, gap: 0.12, jitter: 0.07, pri: 0.5 },
  step_slow: { wet: 0.5, gap: 0.3, jitter: 0.03, pri: 0.5 },         // his tread in a cutscene: lower, slower, more of the hall in it
  step_run: { wet: 0.3, gap: 0.1, jitter: 0.07, pri: 0.6 },
  roll: { wet: 0.32, gap: 0.3, pri: 0.9 },
  swing_light: { wet: 0.22, gap: 0.12, jitter: 0.06 },
  swing_heavy: { wet: 0.25, gap: 0.2, jitter: 0.05 },
  hit_armor: { wet: 0.4, gap: 0.06, jitter: 0.04, pri: 1.4 },
  hit_armor_heavy: { wet: 0.42, gap: 0.08, jitter: 0.03, pri: 1.6, duck: [0.25, 0.4] },
  hurt: { wet: 0.35, gap: 0.12, jitter: 0.03, pri: 2, duck: [0.45, 0.7] },
  block: { wet: 0.4, gap: 0.08, jitter: 0.04, pri: 1.8, duck: [0.3, 0.4] },
  guard_break: { wet: 0.42, gap: 0.3, jitter: 0.02, pri: 2, duck: [0.45, 0.8] },
  clash: { wet: 0.45, gap: 0.08, jitter: 0.05, pri: 1.3 },
  flask: { wet: 0.25, gap: 0.5, jitter: 0.01 },
  sword_draw: { wet: 0.35, gap: 0.5, jitter: 0.02, pri: 1.5 },          // no event of the bus: the opening calls it (audio.play('sword_draw', { pos }))
  // ---- the Cantor
  boss_step: { wet: 0.4, ref: 16, gap: 0.2, jitter: 0.05, pri: 1.2 },
  boss_swing: { wet: 0.35, ref: 16, gap: 0.25, jitter: 0.04, pri: 1.3 },
  slam: { wet: 0.5, ref: 22, gap: 0.25, jitter: 0.03, pri: 2.5, duck: [0.5, 0.9] },
  stagger: { wet: 0.45, ref: 16, gap: 0.5, jitter: 0.02, pri: 2 },
  pipes: { wet: 0.45, ref: 30, gap: 1, jitter: 0, pri: 2.2 },
  pipes_ring: { wet: 0.5, ref: 30, gap: 0.3, jitter: 0, pri: 1.8 },
  hymn_cast: { wet: 0.5, ref: 20, gap: 0.4, jitter: 0.01, pri: 1.6 },
  hymn_fly: { wet: 0.4, ref: 14, gap: 0.08, jitter: 0.05, pri: 1.2 },
  tide: { wet: 0.4, ref: 30, gap: 1, jitter: 0.02, pri: 2 },
  // ---- the hall
  candle_hiss: { wet: 0.35, gap: 0.05, jitter: 0.12, pri: 0.4 },
  candles_out: { wet: 0.4, gap: 1.5, jitter: 0.02, pri: 2, duck: [0.3, 1.5] },
  candles_snuff: { wet: 0.4, gap: 0.6, jitter: 0.05, pri: 1 },
  candles_relight: { wet: 0.45, gap: 1.2, jitter: 0.03, pri: 0.9 },
  bell: { wet: 0.5, gap: 2, jitter: 0, pri: 3, duck: [0.35, 3] },
  drip: { wet: 0.75, ref: 12, gap: 0.2, jitter: 0.12, pri: 0.3 },
  bed_nave: { wet: 0, jitter: 0 },
  // ---- the interface
  ui_move: { ui: true, gap: 0.04, jitter: 0.02 },
  ui_select: { ui: true, gap: 0.08, jitter: 0.01 },
  ui_back: { ui: true, gap: 0.08, jitter: 0.01 },
};

export const DEFAULTS = { trim: 1, wet: 0.3, ref: 9, gap: 0.05, jitter: 0.05, pri: 1, ui: false, duck: null };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Listen to the bus and choose the sounds (docs/engine.md, "Events"). Returns the functions that stop listening.
 * Nothing here keeps a position it was handed, and nothing allocates when an event arrives.
 */
export function wire(audio, ctx) {
  const bus = ctx.bus, offs = [];
  if (!bus) return offs;
  const on = (name, fn) => { const off = bus.on(name, fn); offs.push(typeof off === 'function' ? off : () => bus.off(name, fn)); };
  const P = { x: 0, y: 0, z: 0 }, O = { pos: P, volume: 1, rate: 1, take: undefined };  // one scratch place and one scratch set of options
  const at = (pos, up, volume = 1, rate = 1) => { P.x = pos.x; P.y = (pos.y || 0) + up; P.z = pos.z; O.volume = volume; O.rate = rate; return O; };
  const time = () => (ctx.game ? ctx.game.time : 0);
  /** Is someone standing at this place in the picture now? (through the lens's own matrices: his feet OR his middle
   *  inside the frame with a little margin, and not behind the lens. A shot of his boots alone shows no middle.) */
  const inFrame = (x, y, z) => {
    const cam = ctx.camera, v = cam.matrixWorldInverse.elements, q = cam.projectionMatrix.elements;
    const vx = v[0] * x + v[4] * y + v[8] * z + v[12], vy = v[1] * x + v[5] * y + v[9] * z + v[13], vz = v[2] * x + v[6] * y + v[10] * z + v[14];
    if (vz > -0.05) return false;                                  // behind the lens
    const w = q[3] * vx + q[7] * vy + q[11] * vz + q[15]; if (!(w > 0)) return false;
    return Math.abs((q[0] * vx + q[4] * vy + q[8] * vz + q[12]) / w) < 1.15 && Math.abs((q[1] * vx + q[5] * vy + q[9] * vz + q[13]) / w) < 1.25;
  };
  const seen = (pos) => {
    const cam = ctx.camera; if (!cam || !cam.projectionMatrix || !cam.matrixWorldInverse) return true;
    const y = pos.y || 0;
    return inFrame(pos.x, y + 0.1, pos.z) || inFrame(pos.x, y + 1.0, pos.z);
  };
  let blockT = -9, spentT = -9, brokeT = -9, lit = 1, candles = null, candlesT = -9, candlesLit = 1, resetT = -9;

  on('step', (e) => {
    if (!e || !e.pos) return;
    if (e.who === 'boss') audio.play('boss_step', at(e.pos, 0.1, e.run ? 1.1 : 0.9));
    else if (ctx.cine && ctx.cine.playing) {
      // In a cutscene his step is part of a quiet picture, not of play. The step of play is a thin bright splash; once a
      // second under held strings it was comic (Kevin, 9 Nov: "when the pilgrim appears and he steps, the music/sounds
      // too goofy"). So: a darker, heavier tread (`step_slow`), and none at all for a step that is not in the picture
      // (he sets off 1.8 s before the cut to the doors: that first splash came out of nowhere).
      // (and it is quiet: half the level of a step of play close to the lens, a quarter when he is far off at the doors)
      if (seen(e.pos)) { const cam = ctx.camera, d = cam ? Math.hypot(e.pos.x - cam.position.x, e.pos.z - cam.position.z) : 3; audio.play('step_slow', at(e.pos, 0.1, 0.5 * Math.min(1, Math.max(0.5, 2.5 / Math.max(0.5, d))))); }
    } else audio.play(e.run ? 'step_run' : 'step_walk', at(e.pos, 0.1));
  });
  on('roll', (e) => { if (e && e.pos) audio.play('roll', at(e.pos, 0.3)); });
  on('land', (e) => {
    if (!e || !e.pos) return;
    if (e.who === 'boss') audio.play('boss_step', at(e.pos, 0.1, e.hard ? 1.5 : 1.2, 0.9));
    else audio.play('step_run', at(e.pos, 0.1, e.hard ? 1.5 : 1.2, 0.92));
  });
  // The air of a stroke is heard BEFORE the blade arrives. His: the bus tells it a moment ahead ('whoosh', 0.11 s before
  // 'swing', a heavy stroke 0.16), and the recordings are loudest 0.10 / 0.15 s in: at the moment the stroke goes live,
  // just before it lands. Hers: her blade is live from 'swing' and meets the floor 0.13 to 0.27 s later; her recordings
  // are loudest 0.14 s in. (Until 9 Nov both were loudest well after the blow: clang, then whoosh.)
  on('whoosh', (e) => { if (e && ctx.player && ctx.player.pos) audio.play(e.heavy ? 'swing_heavy' : 'swing_light', at(ctx.player.pos, 1.2)); });
  on('swing', (e) => { if (e && e.who === 'boss' && ctx.boss && ctx.boss.pos) audio.play('boss_swing', at(ctx.boss.pos, 3.4)); });
  on('hit', (e) => {
    if (!e) return;
    const t = e.target, where = e.point || (t && t.pos); if (!where) return;
    const up = e.point ? 0 : t === ctx.boss ? 3 : 1.1;
    if (t === ctx.player) {
      if (e.blocked) {
        blockT = time();
        if (blockT - spentT < 0.12 && blockT - brokeT > 0.3) { brokeT = blockT; audio.play('guard_break', at(where, up)); }
        else audio.play('block', at(where, up, e.heavy ? 1 : 0.8));
      } else if (e.kind === 'chorale' || e.kind === 'hymn') {          // struck by light: the blow, lighter and higher, and a bright ring on it
        audio.play('hurt', at(where, up, 0.7, 1.12)); audio.play('clash', at(where, up, 0.7, 1.1));
      } else if (e.kind === 'tide' || e.kind === 'leap') {             // struck by water
        audio.play('hurt', at(where, up, 0.75, 1.05)); audio.play('roll', at(where, up, 1.1));
      } else audio.play('hurt', at(where, up, e.fatal ? 1.15 : clamp(0.75 + (e.damage || 0) / 120, 0.75, 1.1)));
    } else if (e.heavy) audio.play('hit_armor_heavy', at(where, up, e.fatal ? 1.15 : 1));
    else audio.play('hit_armor', at(where, up, e.fatal ? 1.2 : 1));
  });
  on('stamina-out', () => {                                   // out of breath under a blow: the guard breaks
    spentT = time();
    if (spentT - blockT < 0.12 && spentT - brokeT > 0.3 && ctx.player) { brokeT = spentT; audio.play('guard_break', at(ctx.player.pos, 1.1)); }
  });
  on('clash', (e) => {                                    // blade on shield, or on stone: { stone, floor, weight | heavy, who }
    if (!e || !e.point) return;
    const big = e.heavy || e.weight === 'heavy' || e.weight === 'colossal';
    if (e.who === 'boss' && e.stone) {                      // five metres of her blade stopped by a pier: the tack and ring of steel on stone, low, and the stone's own thud under it
      audio.play('clash', at(e.point, 0, 1.15, 0.72)); audio.play('slam', at(e.point, 0, 0.5, 1.12));
    } else if (e.stone && e.floor) audio.play('clash', at(e.point, 0, big ? 0.7 : 0.45, big ? 0.85 : 1));      // his point on the floor under the water: quiet (the splash is the roll's and the steps' business)
    else if (e.stone) { audio.play('clash', at(e.point, 0, big ? 1.1 : 0.8, big ? 0.86 : 1)); if (big) audio.play('block', at(e.point, 0, 0.6, 0.8)); }      // his blade on a pier or a fallen stone, by the blow's weight: a charged blow has a body under its ring
    else audio.play('clash', at(e.point, 0));
  });
  on('heal', () => { if (ctx.player) audio.play('flask', at(ctx.player.pos, 1.3)); });
  // The lock has no sound, and neither has a held blow coming ready: the reticle and the lens's small pull say both.
  // (Until 10 Nov each had a wooden tick with a glockenspiel bar. The game locks on by itself 0.3 s into every fight, so
  // the first sound of each fight was that tick, alone in a quiet moment: it read as a stray click.)
  // A fall has no sound of its own: the rescue that follows has its lamp (src/cine/rescue.js). (Until 10 Nov a bell
  // rang under "You died".)
  on('boss-slam', (e) => {                                // her blade or her heel on the flooded floor: cleave 1, leap 1.3, stomp and the Tide's scoop 0.8
    if (!e || !e.pos) return;
    const p = e.power === undefined ? 1 : e.power;
    if (p < 0.6) {                                          // the point of a cut touching down (0.4, with every cut of a combo): water thrown and a tick of steel on the stone under it. Not the great slam: that would be a bass drum and a bow of the music on every cut
      audio.play('roll', at(e.pos, 0.1, 0.5 + 0.6 * p, 0.82)); audio.play('clash', at(e.pos, 0.05, 0.3 + 0.5 * p, 0.8));
      return;
    }
    audio.play('slam', at(e.pos, 0.2, clamp(0.3 + 0.7 * p, 0.4, 1.1), clamp(1.15 - 0.15 * p, 0.9, 1.12)));       // (it is already as loud as its peak allows: a bigger blow is lower, not louder)
  });
  on('boss-stagger', () => { if (ctx.boss) audio.play('stagger', at(ctx.boss.pos, 2.5)); });
  on('boss-died', () => { if (ctx.boss) audio.play('stagger', at(ctx.boss.pos, 2, 0.8, 0.92)); });       // she goes to her knees
  on('boss-move', (e) => {                                // docs/modules/boss.md: windup once, active for each blow / ring / blade, recover once
    if (!e || !e.name || !ctx.boss) return;
    const n = String(e.name).toLowerCase(), b = ctx.boss.pos;
    if (n === 'chorale') {
      if (e.stage === 'windup') audio.play('pipes', at(b, 5));
      else if (e.stage === 'active') { at(b, 4); O.take = (e.n || 1) - 1; audio.play('pipes_ring', O); O.take = undefined; }      // each ring a step higher
    } else if (n === 'hymn') {
      if (e.stage === 'windup') audio.play('hymn_cast', at(b, 6));
      else if (e.stage === 'active') audio.play('hymn_fly', at(b, 6));
    } else if (n === 'tide') { if (e.stage === 'active' && (e.n || 1) === 1) audio.play('tide', at(b, 0.3)); }
  });
  // The candles change for two reasons: something happens to them in the world (her wind, her failing light), or the
  // game puts the hall back as it was (a new attempt, a skipped cutscene). Only the first has a sound. The game resets
  // and changes state in one step, so the sound waits for the end of the step to see which it was.
  on('candles', (e) => { if (e) { candles = e.how; candlesT = time(); candlesLit = typeof e.lit === 'number' ? e.lit : lit; } });
  on('player-respawn', () => { resetT = time(); });
  on('state', () => { resetT = time(); audio.musicKeep(); });
  audio.afterStep = () => {
    if (!candles) return;
    if (Math.abs(candlesT - resetT) > 0.05) {
      if (candles === 'relight') audio.play('candles_relight');
      else if (candlesLit < 0.05) audio.play('candles_out');           // every candle in the hall
      else audio.play('candles_snuff', ctx.boss ? at(ctx.boss.pos, 0.3) : undefined);      // a ring of them round her
    }
    lit = candlesLit; candles = null;
  };
  on('cine', (e) => { if (e && !e.on && e.skipped) audio.hush(0.15); });
  on('setting', (e) => { if (e && (e.key === 'music' || e.key === 'sfx' || e.key === 'voice') && ctx.ui && ctx.ui.settings) audio.setVolumes(ctx.ui.settings); });
  // the interface says what was chosen; it calls audio.play('ui_move') itself when the highlight moves
  if (ctx.ui && typeof ctx.ui.on === 'function') {
    try {
      ctx.ui.on((e) => {
        if (!e || time() < 0.25) return;                    // (the interface applies its saved settings as the game starts: no tick for that)
        if (e.type === 'play' || e.type === 'resume' || e.type === 'restart' || e.type === 'title') audio.play('ui_select'); else if (e.type === 'setting') audio.play('ui_move');
      });
    } catch (err) { /* an interface without events */ }
  }
  return offs;
}
