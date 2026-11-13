// The icon for a playlist or folder, the same wherever playlists are listed
// (the left panel, the playlist manager). A playlist can have one of the
// built-in icons picked for it (Change icon…, or in the New dialog); kept in
// the settings by playlist GUID.

import { icon } from '../core/icons.js';
import * as store from '../core/store.js';
import { COLLECTION, FAVORITES } from '../data/playlists.js';

/** [icon name, label] for the picker; '' is the playlist's own (by kind). */
export const PLAYLIST_ICONS = [
  ['', 'Default'],
  ['plStar', 'Star'],
  ['plNote', 'Music'],
  ['plHeadphones', 'Headphones'],
  ['plVinyl', 'Record'],
  ['plGuitar', 'Guitar'],
  ['plPiano', 'Piano'],
  ['plMic', 'Microphone'],
  ['plRadio', 'Radio'],
  ['plParty', 'Party'],
  ['plCrown', 'Crown'],
  ['plSparkle', 'Sparkle'],
  ['plFlame', 'Flame'],
  ['plBolt', 'Energy'],
  ['plDumbbell', 'Workout'],
  ['plCar', 'Drive'],
  ['plPlane', 'Travel'],
  ['plGlobe', 'World'],
  ['plHome', 'Home'],
  ['plBriefcase', 'Work'],
  ['plBook', 'Study'],
  ['plCoffee', 'Coffee'],
  ['plGamepad', 'Games'],
  ['plClock', 'Clock'],
  ['plSun', 'Morning'],
  ['plMoon', 'Night'],
  ['plCloud', 'Cloudy'],
  ['plRain', 'Rain'],
  ['plSnow', 'Winter'],
  ['plLeaf', 'Calm'],
];

const VALID = new Set(PLAYLIST_ICONS.map(([n]) => n));

/** The icon picked for a playlist ('' for its own). */
export function pickedIcon(guid) {
  const name = store.get('playlistIcons')?.[guid] || '';
  return VALID.has(name) ? name : '';
}

export function setPickedIcon(guid, name) {
  const all = { ...(store.get('playlistIcons') || {}) };
  if (name) all[guid] = name;
  else delete all[guid];
  store.set('playlistIcons', all);
}

/** A playlist's own icon by kind (what "Default" shows). */
export function defaultIconName(p) {
  if (p?.name === COLLECTION) return 'collection';
  if (p?.name === FAVORITES) return 'heart';
  return p?.isAutoplaylist ? 'autoplaylist' : 'playlist';
}

export function playlistIcon(p) {
  const special = p.name === COLLECTION || p.name === FAVORITES;
  return icon((!special && pickedIcon(p.guid)) || defaultIconName(p));
}

/** A closed or an open folder. */
export function folderIcon(f) {
  return icon(f.collapsed ? 'folder' : 'folderOpen');
}
