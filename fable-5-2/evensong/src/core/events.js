// A very small event bus. Modules announce facts on it (docs/engine.md lists them); nobody gives orders through it.
export class Bus {
  constructor() { this.map = new Map(); }
  on(name, fn) { let l = this.map.get(name); if (!l) this.map.set(name, l = []); l.push(fn); return () => this.off(name, fn); }
  off(name, fn) { const l = this.map.get(name); if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } }
  emit(name, data) {
    const l = this.map.get(name);
    if (l) for (let i = 0; i < l.length; i++) { try { l[i](data); } catch (e) { console.error(`listener for "${name}" failed`, e); } }
    const all = this.map.get('*');
    if (all) for (let i = 0; i < all.length; i++) all[i](name, data);
  }
}
