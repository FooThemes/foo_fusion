// Favourite ("loved") songs, as in the original skin: a song is a favourite
// when its MOOD tag is "Like it". The Favorites autoplaylist collects them.
// Writing goes to the files' tags, so favourites survive library rebuilds and
// show up in any other player that reads MOOD.

import { call, tryCall } from '../core/bridge.js';
import { Emitter } from '../core/emitter.js';

export const LOVED_VALUE = 'Like it';
export const MOOD_TF = '[%mood%]';

class Favourites extends Emitter {
  #known = new Map(); // handle -> boolean (what we last read or wrote)

  /** From a track row fetched with formats: { m: MOOD_TF }. */
  isLoved(track) {
    if (!track) return false;
    if (this.#known.has(track.handle)) return this.#known.get(track.handle);
    return isLovedValue(track.formats?.m);
  }

  /** Read the state for handles we have no row for (e.g. the playing track). */
  async load(handles) {
    if (!handles.length) return [];
    const res = await tryCall('titleformat.evalBatch', { paths: handles, pattern: MOOD_TF });
    return handles.map((h, i) => {
      const on = isLovedValue(res?.results?.[i]?.result);
      this.#known.set(h, on);
      return on;
    });
  }

  async set(handles, on) {
    if (!handles.length) return;
    handles.forEach((h) => this.#known.set(h, on));
    this.emit('change', { handles, on });
    try {
      for (let i = 0; i < handles.length; i += 200) {
        await call('metadata.writeBatch', {
          items: handles.slice(i, i + 200).map((path) => ({ path, tags: { MOOD: on ? LOVED_VALUE : null } })),
        });
      }
    } catch (err) {
      // Put the hearts back the way they were if the write was refused.
      handles.forEach((h) => this.#known.set(h, !on));
      this.emit('change', { handles, on: !on });
      throw err;
    }
  }

  toggle(handle, current) {
    return this.set([handle], !current);
  }
}

function isLovedValue(v) {
  return String(v || '')
    .split(/[;,]/)
    .some((s) => s.trim().toLowerCase() === LOVED_VALUE.toLowerCase());
}

export const favourites = new Favourites();
