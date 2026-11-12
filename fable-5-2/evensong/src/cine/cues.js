// Cinematics: the moments of the score the pictures are cut to. The score owner's assets/audio/music/music.json gives
// each section's named cues in seconds (docs/modules/score.md); these are the same numbers, kept here so a cutscene
// still runs when that file is missing.
const FALLBACK = {
  intro: { candle: 0, nave: 6, doors: 15, sight: 21, mask: 24, line: 25.5, lineEnd: 31, rise: 30, chord: 33, draw: 39, sweep: 45, fall: 48, name: 51, end: 57 },
  turn: { out: 5, line: 5.2083, chord: 7.5, end: 12.5 },
  ending: { tune: 3, last: 27, end: 33 },
};
/** The spoken lines: the Cantor's three and the rescue's two; the words, and how long each takes to say until the recordings tell us. */
export const LINES = {
  cantor_intro: { text: 'Put out your light, pilgrim. The choir is sleeping.', seconds: 4.8 },
  cantor_phase: { text: 'Then you will sing with them.', seconds: 2.3 },
  cantor_end: { text: 'Let them wake.', seconds: 1.6 },
  // the voice over a rescue (src/cine/rescue.js), in turn; his words, lower case as he wrote them, subtitles too
  voice_save: { text: 'i need to save you too?', seconds: 1.6 },
  voice_fries: { text: 'what a waste of fries', seconds: 1.5 },
};

/** The cue times of a section of the score: { name: seconds, ... }. */
export function cues(ctx, section) {
  const out = Object.assign({}, FALLBACK[section]);
  const a = ctx.assets, m = a && a.has && a.has('cine.music') ? a.json('cine.music') : null, s = m && m[section];
  if (s && s.cues) for (const k in s.cues) if (Number.isFinite(s.cues[k])) out[k] = s.cues[k];
  return out;
}

/** A spoken line: { text, seconds }, with the recording's own text and length when the sound module has them. */
export function line(ctx, name) {
  const l = Object.assign({}, LINES[name]);
  const info = ctx.audio && ctx.audio.voiceInfo ? ctx.audio.voiceInfo(name) : null;          // the sound owner knows its recordings
  const a = ctx.assets, v = !info && a && a.has && a.has('cine.voice') ? a.json('cine.voice') : null;
  const e = info || (v && (v[name] || (v.lines && v.lines[name])));
  const sec = typeof e === 'number' ? e : e && (e.duration || e.seconds || e.length);
  if (Number.isFinite(sec) && sec > 0.2) l.seconds = sec;
  if (e && typeof e.text === 'string') l.text = e.text;
  return l;
}
