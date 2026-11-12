// window.__WK_DEBUG__: scripted input + state inspection for automated verification.
export function installDebug(game) {
  const v3 = (v) => v && [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
  const fx = (v, n = 2) => (typeof v === "number" ? +v.toFixed(n) : null);
  const log = [];
  game.debugLog = (entry) => { log.push({ t: +game.simTime.toFixed(3), ...entry }); if (log.length > 500) log.shift(); };
  const actor = (a) => a && {
    pos: v3(a.ch.position), yaw: +a.ch.yaw.toFixed(3), hp: a.hp, maxHp: a.maxHp, state: a.state,
    clip: a.ch.clipName, clipTime: +a.ch.clipTime.toFixed(3), grounded: a.ctl.grounded,
  };
  window.__WK_DEBUG__ = {
    game,
    get log() { return log; },
    state() {
      const p = game.player, b = game.boss;
      const started = game.state !== "loading" && game.state !== "ready";
      return {
        state: game.state, fps: fx(game.fps(), 1), simTime: fx(game.simTime), loadError: game.loadError || null,
        player: p && started && { ...actor(p), mp: p.mp, stamina: fx(p.stamina, 1), focus: fx(p.focus, 1), focusPips: p.focusPips,
          gourd: p.gourdCharges, lockOn: p.lockOn, invuln: p.invulnerable(), action: p.action?.kind ?? null },
        boss: b && started && { ...actor(b), phase: b.phase, fsm: b.fsm, comboBudget: b.comboBudget, watchTime: fx(b.watchTime),
          skill: b.skill?.id ?? null, task: b.task ? b.taskNode?.id : null, alive: b.alive, aware: b.aware },
      };
    },
    start() { if (game.state === "ready") { document.querySelector("#loading").click(); return true; } return false; },
    restart() { game.restart(); },
    down(code) { game.input.down(code); },
    up(code) { game.input.up(code); },
    async tap(code, ms = 60) { game.input.down(code); await new Promise((r) => setTimeout(r, ms)); game.input.up(code); },
    look(dx, dy = 0) { game.input.look(dx, dy); },
    setHp(who, hp) { const a = who === "boss" ? game.boss : game.player; a.hp = Math.max(0, Math.min(a.maxHp, hp)); },
    damage(who, amount) { (who === "boss" ? game.boss : game.player).applyDamageDirect(amount); },
    timeScale(s) { game.timeScale = s; },
    godMode(on = true) { game.player.god = on; },
    bossAi(on = true) { game.boss.aiEnabled = on; },
    forceSkill(id) { return game.boss.forceSkill(id); },
    teleport(who, x, y, z) { const a = who === "boss" ? game.boss : game.player; a.ch.position.set(x, y, z); },
    clips(who) { return [...(who === "boss" ? game.boss : game.player).ch.clips.keys()]; },
    /** audio.js state: ctx, bgm, rms per bus, recent played events, unmapped requests (game.audio for post/stop/rms) */
    get audio() { return game.audio?.debugState() ?? null; },
    /** 定身法 / 聚形散气: spell("immobilize" | "cloud", force) presses the spell (force: clear cooldowns, refill MP) */
    spell(name, force = false) { if (force) game.spells?.ready(); game.player.press("spell:" + name); return game.spells?.state(); },
    spells() { return game.spells?.state() ?? null; },
  };
}
