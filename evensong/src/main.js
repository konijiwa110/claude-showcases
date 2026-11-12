// Evensong: start the page. Everything about testing and looking at things (?dev, &shot, &at ...) is in src/dev.js.
import { Game } from './game.js';

const params = new URLSearchParams(location.search);

async function main() {
  const game = new Game({ canvas: document.getElementById('view'), uiRoot: document.getElementById('ui'), params });
  window.game = game;
  await game.load();
  const dev = game.dev || params.has('at') ? await import('./dev.js') : null;
  if (!dev) { game.start('title'); return; }
  if (await dev.attach(game, params)) return;                    // a picture or a timing run: dev.js drove the clock itself
  game.loop.start();                                             // a dev session: dev.js chose the starting point
}

main().catch((err) => {
  console.error(err);
  document.title = 'error: ' + err.message;
  // a picture or test run is waiting for a file: tell the tool at once why none will come
  const waiting = params.get('shot') || params.get('perf') || params.get('fight');
  if (waiting) fetch('/__shot/' + waiting + '.error.txt', { method: 'POST', body: String((err && err.stack) || err) }).catch(() => {});
  const p = document.createElement('p');
  p.textContent = 'Could not start the game: ' + err.message;
  p.style.cssText = 'position:fixed;left:24px;top:24px;font:16px system-ui;color:#f4efe6;max-width:70ch';
  document.body.appendChild(p);
});
