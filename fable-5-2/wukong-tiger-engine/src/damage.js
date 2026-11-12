// Damage model (data/tiger.json damageModel, implemented literally for both directions).
// pre = (A.attack*e.damageMult + e.flatDamage) * max(0.2, (1 - V.dmgDef/10000) * (1 + A.dmgAddition/10000))
// T = A.trueDamageRatio; desired = V is player ? playerDesiredHp : V.hpMax; trueD = pre*T*V.hpMax/desired
// defMul = 1 - 0.48*V.defense/(90 + 0.52*|V.defense|)
// crit = rand(1..10000) <= A.critRate ? max(1, 1.3 + A.critMultiplier/10000) : 1; noise = uniform(0.97, 1.03)
// physD = pre*(1-T)*defMul*crit*noise; damage = floor(trueD + physD)

/**
 * @param model damageModel {formula, params}
 * @param A attacker stats {attack, dmgAddition, trueDamageRatio, critRate, critMultiplier}
 * @param V victim {stats {dmgDef, defense}, maxHp, isPlayer}
 * @param e damage effect {damageMult, flatDamage}
 * @param rng () => [0,1)
 * @returns {damage, crit}
 */
export function computeDamage(model, A, V, e, rng = Math.random) {
  const p = model.params;
  const vs = V.stats;
  const pre = (A.attack * (e.damageMult ?? 0) + (e.flatDamage ?? 0)) *
    Math.max(p.minPreMultiplier, (1 - (vs.dmgDef ?? 0) / 10000) * (1 + (A.dmgAddition ?? 0) / 10000));
  const T = A.trueDamageRatio ?? 0;
  const desired = V.isPlayer ? p.playerDesiredHp : V.maxHp;
  const trueD = pre * T * V.maxHp / desired;
  const def = vs.defense ?? 0;
  const defMul = 1 - p.defA * def / (p.defB + p.defC * Math.abs(def));
  const roll = 1 + Math.floor(rng() * 10000);
  const isCrit = roll <= (A.critRate ?? 0);
  const crit = isCrit ? Math.max(1, p.critBase + (A.critMultiplier ?? 0) / 10000) : 1;
  const noise = p.noiseMin + rng() * (p.noiseMax - p.noiseMin);
  const physD = pre * (1 - T) * defMul * crit * noise;
  return { damage: Math.floor(trueD + physD), crit: isCrit };
}
