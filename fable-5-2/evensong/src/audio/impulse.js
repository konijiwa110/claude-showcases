// The hall: an impulse response for a roofless stone nave, built in code (no file), the same on every run.
//
//   naveImpulse(rate = 48000, seconds = 3.6) -> { left: Float32Array, right: Float32Array, rate, seconds }
//
// What it is: 18 ms of nothing (the dry sound is mixed separately), a handful of dull slaps off the arcades and the
// far walls in the first tenth of a second (different on each side), then a diffuse tail in four bands that die away
// at different speeds: the low end rolls on for about four seconds, the top is gone in under one. So the tail is dark,
// as stone and open sky make it. Each channel is scaled to unit energy: a steady sound sent to the hall at send 1 comes
// back as loud as it went in, spread over the decay. tools/sfx/hall.py is the same recipe in Python (the voices are
// set in the hall offline with it); tools/sfx/audiotest.html measures this one.
export const NAVE = {
  seconds: 3.6,
  predelay: 0.018,
  // band edges (Hz) and how long each band takes to fall 60 dB (seconds), and its level (dB)
  bands: [
    { lo: 0, hi: 250, rt: 4.1, db: 0 },
    { lo: 250, hi: 1200, rt: 3.5, db: -1 },
    { lo: 1200, hi: 4000, rt: 2.1, db: -5 },
    { lo: 4000, hi: 24000, rt: 0.85, db: -11 },
  ],
  // the first reflections: [seconds, level] for the left and the right ear
  early: [
    [[0.0190, 0.80], [0.0272, -0.62], [0.0381, 0.55], [0.0467, -0.47], [0.0594, 0.42], [0.0718, -0.36], [0.0883, 0.31], [0.1034, -0.26]],
    [[0.0221, -0.78], [0.0313, 0.64], [0.0352, -0.52], [0.0521, 0.46], [0.0633, -0.40], [0.0771, 0.35], [0.0925, -0.30], [0.1097, 0.25]],
  ],
  earlyLevel: 0.5,          // the slaps' share of the energy, against the tail's 1
};

/** A small seeded random source: the hall is the same hall every time. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function naveImpulse(rate = 48000, seconds = NAVE.seconds) {
  const n = Math.floor(seconds * rate), out = [new Float32Array(n), new Float32Array(n)];
  const pre = Math.floor(NAVE.predelay * rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = out[ch], rand = seeded(ch ? 0x51ed270b : 0x2545f491);
    // ---- the tail: white noise split into bands; each band has its own decay
    const nb = NAVE.bands.length, lp = new Float64Array(nb * 3), k = new Float64Array(nb), amp = new Float64Array(nb), dec = new Float64Array(nb);
    for (let b = 0; b < nb; b++) {
      const band = NAVE.bands[b];
      k[b] = band.hi >= rate / 2 ? 1 : 1 - Math.exp(-2 * Math.PI * band.hi / rate);        // low-pass at the band's upper edge
      amp[b] = Math.pow(10, band.db / 20);
      dec[b] = Math.exp(-6.9078 / (band.rt * rate));                                        // per sample: 60 dB in rt seconds
    }
    const env = new Float64Array(nb).fill(1);
    let tail = 0;
    for (let i = pre; i < n; i++) {
      const w = rand() * 2 - 1, t = (i - pre) / rate;
      let prev = 0, s = 0;
      for (let b = 0; b < nb; b++) {
        // everything below this band's upper edge: three poles one after another (18 dB an octave), so that the slow
        // low bands do not leak upward and keep the top of the tail alive
        const j = b * 3;
        lp[j] += k[b] * (w - lp[j]); lp[j + 1] += k[b] * (lp[j] - lp[j + 1]); lp[j + 2] += k[b] * (lp[j + 1] - lp[j + 2]);
        const low = k[b] === 1 ? w : lp[j + 2];
        s += (low - prev) * amp[b] * env[b];                 // minus everything below its lower edge
        prev = low; env[b] *= dec[b];
      }
      const rise = t < 0.09 ? t / 0.09 : 1;                  // the tail gathers over the first tenth of a second
      const v = s * rise * rise * (3 - 2 * rise);
      d[i] = v; tail += v * v;
    }
    // the last 60 ms fade to nothing, so the convolution does not end on a step
    const fade = Math.floor(0.06 * rate);
    for (let i = 0; i < fade; i++) d[n - 1 - i] *= i / fade;
    const tk = 1 / Math.sqrt(tail + 1e-20);
    for (let i = 0; i < n; i++) d[i] *= tk;                  // the tail alone has unit energy
    // ---- the slaps: short bursts of dulled noise, a few milliseconds each
    let early = 0;
    const slaps = new Float32Array(Math.floor(0.13 * rate));
    for (const [at, level] of NAVE.early[ch]) {
      const i0 = Math.floor(at * rate), len = Math.floor(0.004 * rate), fall = 0.0011 * rate;
      let y = 0;
      for (let j = 0; j < len && i0 + j < slaps.length; j++) { y += 0.22 * ((rand() * 2 - 1) * Math.exp(-j / fall) - y); slaps[i0 + j] += level * y; }
    }
    for (let i = 0; i < slaps.length; i++) early += slaps[i] * slaps[i];
    const ek = Math.sqrt(NAVE.earlyLevel / (early + 1e-20));
    for (let i = 0; i < slaps.length && i < n; i++) d[i] += slaps[i] * ek;
    // ---- the whole thing to unit energy
    let sum = 0;
    for (let i = 0; i < n; i++) sum += d[i] * d[i];
    const g = 1 / Math.sqrt(sum + 1e-20);
    for (let i = 0; i < n; i++) d[i] *= g;
  }
  return { left: out[0], right: out[1], rate, seconds };
}
