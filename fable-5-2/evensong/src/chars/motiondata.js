// Clips taken from a performer and added beside a character's Mixamo pack (assets/models/<name>.motion.glb, made by
// tools/blender_motion_pack.py from source-art/mixamo/specs/<name>_motion.json). This file is written by hand:
// clipdata.js is generated from the Mixamo pack alone and would lose these lines at its next rebuild.
//
// The numbers come from that tool's own print-out (assets/models/<name>.motion.json): rebuild the file, copy them here.
//   travel   where the clip carries him, meters: [to his left, forward]
//   events   his footfalls: when each ankle comes to stand
//   marks    moments a cutscene steers by, in seconds of the clip

export const knight = {
  // He walks in upright with his arms swinging, slows, closes his feet and stands (one take, ten seconds). The feet's
  // places on the floor are his own (the tool lays the hips' path from his planted feet), so play it with its travel:
  // the stage adds the clip's own travel to where he started (src/cine/intro.js).
  walk_in: {
    kind: 'act', loop: false, root: true, travel: [0.009, 8.518],
    marks: { slowing: 5.0, last_step: 7.533, stopped: 7.9 },
    events: [
      { t: 0.667, name: 'foot-r' }, { t: 1.333, name: 'foot-l' }, { t: 1.967, name: 'foot-r' }, { t: 2.533, name: 'foot-l' },
      { t: 3.167, name: 'foot-r' }, { t: 3.733, name: 'foot-l' }, { t: 4.333, name: 'foot-r' }, { t: 4.933, name: 'foot-l' },
      { t: 5.533, name: 'foot-r' }, { t: 6.167, name: 'foot-l' }, { t: 6.833, name: 'foot-r' }, { t: 7.533, name: 'foot-l' },
    ],
  },
};
