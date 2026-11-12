// How hard the fight is: every number of difficulty in one place (docs/design.md, "How hard it is").
//
// The fight was first balanced as a hard one (docs/logs/fightpolish.md) and was filmed that way. On 9 Nov 2026 it
// was made easier (docs/logs/lead.md, "the fight made easier"): PLAY is what the game now runs on. FILM is the fight
// as it was filmed: the played session in video/session_run2/ plays back as the same fight only under those numbers,
// so tools/capture.py asks for them itself (&rules=film). Change PLAY freely; never change FILM.
//
//   const R = rulesFor(ctx.params)       read once by whoever needs a number (the pilgrim, the Cantor)
//   &rules=film                          the fight as it was filmed
//   &rule=health:160,rest:1.5            other numbers for one run, without editing this file (for trying things)
//
// What each number is:
//   health     the pilgrim's health. Her blows are not made lighter: they stagger, throw and sound as they did,
//              and take a smaller share of a longer bar (the bar on screen grows with it)
//   heal       what one flask gives back          flasks     how many he carries
//   herHealth  the Cantor's health (phase two begins at half of it, whatever it is)
//   rest       her pause between two blows, as a multiple of the filmed one (src/chars/boss.js, breathe())
//   quick      how much faster her wind-ups run in phase two
//   punish     seconds for which she favours her lunge and her leap after he drinks in front of her, and cuts her
//              pause short to answer; 0: a drink is not answered
export const FILM = Object.freeze({ health: 100, heal: 45, flasks: 4, herHealth: 1000, rest: 1, quick: 1.12, punish: 1.6 });
export const PLAY = Object.freeze({ health: 130, heal: 58, flasks: 4, herHealth: 800, rest: 1.3, quick: 1, punish: 0 });

export function rulesFor(params) {
  const has = params && typeof params.get === 'function';
  const R = Object.assign({}, has && params.get('rules') === 'film' ? FILM : PLAY);
  for (const part of ((has && params.get('rule')) || '').split(',')) {
    const m = part.trim().match(/^([a-zA-Z]+):(-?[\d.]+)$/);
    if (m && m[1] in R && !Number.isNaN(+m[2])) R[m[1]] = +m[2];
  }
  return R;
}
