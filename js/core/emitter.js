// Minimal event emitter used by the data modules to notify the UI.
export class Emitter {
  #map = new Map();

  on(event, fn) {
    if (!this.#map.has(event)) this.#map.set(event, new Set());
    this.#map.get(event).add(fn);
    return () => this.#map.get(event)?.delete(fn);
  }

  emit(event, data) {
    const set = this.#map.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(data);
      } catch (err) {
        console.error(`[fusion] ${event} listener failed:`, err);
      }
    }
  }
}
