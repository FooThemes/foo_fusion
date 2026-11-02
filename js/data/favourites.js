// Song mood, as in the original skin, stored in the file's MOOD tag:
//   ''        nothing
//   'like'    MOOD = "Like it"  (listed in the Favorites autoplaylist)
//   'hate'    MOOD = "Hate it"
// The heart button cycles nothing -> like -> hate -> nothing. Writing goes to
// the tags, so moods survive library rebuilds and work in other players.

import { call, tryCall } from '../core/bridge.js';
import { Emitter } from '../core/emitter.js';

export const MOOD_TF = '[%mood%]';
const VALUE = { like: 'Like it', hate: 'Hate it' };
export const NEXT = { '': 'like', like: 'hate', hate: '' };

class Favourites extends Emitter {
  #known = new Map(); // handle -> state (what we last read or wrote)
  #written = new Map(); // handle -> time of our own MOOD write

  /** Were all of these just changed by Fusion's own like/dislike? */
  ownChange(handles) {
    const now = performance.now();
    return handles.length > 0 && handles.every((h) => now - (this.#written.get(h) ?? -1e9) < 4000);
  }

  /** State of a track row fetched with formats: { m: MOOD_TF }. */
  state(track) {
    if (!track) return '';
    if (this.#known.has(track.handle)) return this.#known.get(track.handle);
    return parseMood(track.formats?.m);
  }

  isLoved(track) {
    return this.state(track) === 'like';
  }

  /** Read states for handles we have no row for (e.g. the playing track). */
  async load(handles) {
    if (!handles.length) return [];
    const res = await tryCall('titleformat.evalBatch', { paths: handles, pattern: MOOD_TF });
    return handles.map((h, i) => {
      const st = parseMood(res?.results?.[i]?.result);
      this.#known.set(h, st);
      return st;
    });
  }

  async set(handles, state) {
    if (!handles.length) return;
    const before = handles.map((h) => this.#known.get(h));
    const t = performance.now();
    handles.forEach((h) => this.#written.set(h, t));
    handles.forEach((h) => this.#known.set(h, state));
    this.emit('change', { handles, state });
    try {
      for (let i = 0; i < handles.length; i += 200) {
        await call('metadata.writeBatch', {
          items: handles.slice(i, i + 200).map((path) => ({ path, tags: { MOOD: VALUE[state] || null } })),
        });
      }
    } catch (err) {
      // Put the hearts back the way they were if the write was refused.
      handles.forEach((h, i) => (before[i] == null ? this.#known.delete(h) : this.#known.set(h, before[i])));
      handles.forEach((h, i) => this.emit('change', { handles: [h], state: before[i] || '' }));
      throw err;
    }
  }

  /** Advance one song to its next state; returns the new state. */
  async cycle(handle, current) {
    const next = NEXT[current || ''];
    await this.set([handle], next);
    return next;
  }
}

function parseMood(v) {
  const parts = String(v || '')
    .split(/[;,]/)
    .map((s) => s.trim().toLowerCase());
  if (parts.includes('like it')) return 'like';
  if (parts.includes('hate it')) return 'hate';
  return '';
}

export const favourites = new Favourites();
