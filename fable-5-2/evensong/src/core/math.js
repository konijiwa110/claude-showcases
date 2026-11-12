// Small numeric helpers shared by everything.
export const TAU = Math.PI * 2;
export const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, x) => clamp((x - a) / (b - a));
export const smooth = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
export const smoother = (t) => { t = clamp(t); return t * t * t * (t * (t * 6 - 15) + 10); };
/** Move a toward b so that the gap shrinks by the same share every second, whatever the step. rate is "per second". */
export const damp = (a, b, rate, dt) => b + (a - b) * Math.exp(-rate * dt);
/** The shortest signed turn from angle a to angle b. */
export const angleDiff = (b, a) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };
export const dampAngle = (a, b, rate, dt) => a + angleDiff(b, a) * (1 - Math.exp(-rate * dt));
/** Turn a toward b by at most maxStep radians. */
export const turnToward = (a, b, maxStep) => { const d = angleDiff(b, a); return a + clamp(d, -maxStep, maxStep); };
export const approach = (a, b, step) => (a < b ? Math.min(b, a + step) : Math.max(b, a - step));
export const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
/** A repeatable random number from an integer seed (for anything that must look the same every run). */
export function hash(n) { let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16; return (x >>> 0) / 4294967296; }
/** A critically damped spring: state { x, v } follows target. */
export function spring(s, target, rate, dt) { const k = rate * rate, d = 2 * rate; s.v += ((target - s.x) * k - s.v * d) * dt; s.x += s.v * dt; return s.x; }
/** A repeatable stream of random numbers in [0, 1): const r = rng(seed); r(). Use this, never Math.random(), for anything that decides how the fight goes. */
export function rng(seed = 1) { let a = (seed >>> 0) || 1; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
