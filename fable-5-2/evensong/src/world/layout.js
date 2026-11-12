// The Drowned Choir's measurements and where everything stands. The same numbers as tools/kit/dims.py (the kit is
// modelled to them): change them together.
//
// Axes: y up; the nave runs along z; EAST (the organ, the moon) is -z; looking east, +x is on the right (south).
export const BAY = 38 / 7;                 // pier to pier along the nave
export const PIER_X = 13;                  // the arcades stand at x = +-13
export const PIER_Z = Array.from({ length: 8 }, (_, i) => -19 + i * BAY);   // pier 0 is the easternmost
export const BAY_Z = Array.from({ length: 7 }, (_, i) => -19 + (i + 0.5) * BAY);   // bay i lies between pier i and pier i + 1
export const AISLE_X = 20;                 // centre plane of the aisles' outer walls
export const AISLE_FACE = AISLE_X - 0.65;  // their inner face
export const EAST_Z = -25.5, WEST_Z = 22;  // centre planes of the end walls
export const DAIS = { z: -17.6, step: 0.9, rise: 0.5 / 3, top: 0.5 };
export const Y = { spring: 9.3, string: 13.9, trif: 17.3, vault: 19, head: 25.8, aisle: 12.6 };

// What is left of each bay of the nave's wall, east to west. Each state is the stack of kit pieces standing in that
// bay and how high the wall still is at its east and west ends (0 nothing, 1 the arcade, 2 the triforium, 3 the
// clerestory): the vaulting shafts on the piers follow that.
export const STATES = {
  C: { stack: ['arcade_full', 'trif_full', 'clere_full'], e: 3, w: 3 },
  Cb: { stack: ['arcade_full', 'trif_full', 'clere_bare'], e: 3, w: 3 },
  Cj: { stack: ['arcade_full', 'trif_full', 'clere_jambs'], e: 3, w: 3 },
  Cd: { stack: ['arcade_full', 'trif_full', 'clere_down'], e: 3, w: 2 },
  T: { stack: ['arcade_full', 'trif_full'], e: 2, w: 2 },
  Td: { stack: ['arcade_full', 'trif_down'], e: 2, w: 1 },
  Tl: { stack: ['arcade_full', 'trif_low'], e: 1, w: 1 },
  R: { stack: ['arcade_ruin_a'], e: 1, w: 1 },
  Rb: { stack: ['arcade_ruin_b'], e: 1, w: 1 },
  H: { stack: ['arcade_half'], e: 1, w: 0 },
  X: { stack: ['arcade_stub'], e: 0, w: 0 },
};
// '~' after a state turns the bay end for end (what was whole at its east end is whole at its west end).
export const NAVE = {
  s: ['C', 'Cj', 'Td', 'R', 'H', 'Td~', 'Cb'],
  n: ['C', 'Cb', 'Cd', 'T', 'Td', 'Rb', 'Cd~'],
};
// The aisles' outer walls, bay by bay, and the arches that crossed the aisle at each pier ('' = fallen).
export const AISLE = {
  s: { wall: ['full', 'full', 'gap', 'low', 'down~', 'full', 'full'], arch: ['full', 'full', 'broken', '', '', 'broken', 'full', 'full'] },
  n: { wall: ['full', 'gap', 'full', 'down', 'low', 'down~', 'full'], arch: ['full', 'full', 'full', 'broken', '', '', 'full', 'full'] },
};
// Whole transverse arches still crossing the nave (pier line), and which piers carry longer rib stumps.
export const RIBS = { whole: [1, 7], long: { s: [0], n: [2, 0] }, span: 2 * (PIER_X - 0.8), k: 0.7 };
/** Height of the underside of a whole transverse rib above a point x across the nave. */
export function ribY(x) { const R = RIBS.k * RIBS.span, c = R - RIBS.span / 2, a = Math.abs(x) + c; return Y.vault + Math.sqrt(Math.max(0, R * R - a * a)) - 0.3; }
// Chandeliers hang from the whole ribs on long chains: which rib (pier line), where across the nave, how many 4 m lengths of chain.
export const CHANDELIERS = [{ line: 1, x: -4.6, chains: 4, yaw: 0.6 }, { line: 7, x: 5.0, chains: 4, yaw: 2.2 }];

// The play area and what stands in it. Never on the centre line, three metres clear of the spawn points. (The things
// themselves are placed in arena.js from FACE, COLUMN and BLOCKS; what bodies and blades meet is COLLIDERS.)
export const BOUNDS = { hx: 11, hz: 17, r: 4 };
export const SPAWN = {
  player: { x: 0, z: 13, yaw: Math.PI }, boss: { x: 0, z: -9, yaw: 0 },
  door: { x: 0, z: 19.5, yaw: Math.PI }, kneel: { x: 0, z: -13.5, yaw: 0 },
};
export const FACE = { x: -9.2, z: 7.4, r: 1.55, yaw: 0.2 };                    // the great fallen stone head (north-west), against the wall
export const COLUMN = [                                                           // a toppled pier shaft in three drums (south-east): where each drum's middle lies
  { x: 9.3, z: -4.2, r: 0.95 }, { x: 7.75, z: -3.25, r: 0.95 }, { x: 6.15, z: -2.3, r: 0.9 },
];
export const DRUM_AXIS = 0.98;                                                   // a lying drum's own axis above its underside (the kit's drums: tools/kit/props.py)
export const CAPITAL = { yaw: Math.PI + 0.1, sink: -0.02, tip: 0.05, along: 0.55 };   // the third drum (it carries the capital): turned end for end, a little further out
export const BLOCKS = { x: -7.6, z: -9.6, r: 1.15 };                             // fallen vault stones (north-east), and a piece of rib beside them
// What bodies, blades, wings and the camera meet: circles FITTED TO THE DRAWN STONE (worked out from the kit's own
// vertices as they are placed: everything between the water and head height, seen from above), each with the height
// the stone stands there (h, and the same number as `top`: both names are read). Several circles follow a long stone.
// If a stone is moved or remodelled these must be fitted again (docs/logs/lookpolish.md says how).
const stone = (x, z, r, h) => ({ x, z, r, h, top: h });
export const COLLIDERS = [
  // the fallen head: 2.5 m by 3.4 m, 2.2 m high
  stone(-9.27, 7.93, 1.09, 2.2), stone(-9.2, 7.33, 1.26, 2.2), stone(-9.18, 6.73, 1.1, 2.2),
  // the toppled pier: 7 m of shaft 2.1 m thick, from the wall inward; the fifth and sixth are its capital's flare
  stone(9.61, -4.44, 1.05, 1.93), stone(8.72, -3.91, 1.07, 1.93), stone(7.83, -3.38, 1.06, 1.9), stone(7.08, -2.92, 1.12, 2.0),
  stone(6.55, -2.63, 1.33, 2.25), stone(5.8, -2.22, 1.3, 2.25), stone(5.44, -1.82, 1.05, 2.2),
  // the heap of vault stones, and the piece of rib lying against it
  stone(-7.59, -9.6, 1.2, 1.15), stone(-8.03, -10.58, 0.95, 1.4), stone(-8.45, -8.72, 0.34, 0.74), stone(-9.1, -8.52, 0.32, 0.45),
];
