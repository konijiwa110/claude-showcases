// Player extension modules (skills). Each entry is a factory `(game) => module`; main.js calls player.use() on every
// module after the world is built (player, boss, vfx, hud exist). Hook list: Player.use() in player.js.
import { createStances } from "./stances.js";
import { createSpells } from "./spells.js";
import { makeTransform } from "./transform.js";
import { makeSpirit } from "./spirit.js";

export const PLAYER_MODULES = [
  createStances, // 劈棍/立棍/戳棍 (Z/X/C) heavies + follow-ups, 棍花 (V)
  createSpells,  // 定身法 (1), 聚形散气 (2) + 破隐一击
  makeTransform, // 赤潮 (4): 广智 transformation
  makeSpirit,    // 精魄 广谋 (F)
];
