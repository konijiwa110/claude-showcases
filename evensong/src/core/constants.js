// Numbers every module agrees on (docs/engine.md, "Ground rules").
export const DT = 1 / 60;            // the fixed step
export const FLOOR_Y = 0;            // the stone floor of the nave
export const WATER_Y = 0.07;         // the water's surface
export const BOSS_HEIGHT = 6.6;      // the Cantor, standing
export const BOSS_SCALE = BOSS_HEIGHT / 1.8;
/** The voice over a rescue says these in turn, one at each fall (src/cine/rescue.js; the sound keeps the next one ready). */
export const RESCUE_LINES = ['voice_save', 'voice_fries'];
