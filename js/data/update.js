// Is there a newer Fusion? Asks GitHub for the latest release (pre-releases
// don't count) and compares its tag with this version.

import { VERSION } from '../version.js';
import { logInfo } from '../core/log.js';

export const RELEASES_URL = 'https://github.com/FooThemes/foo_fusion/releases';
const API = 'https://api.github.com/repos/FooThemes/foo_fusion/releases/latest';

/** -1, 0 or 1, comparing "3.0.10" with "3.0.9" by number. */
export function compareVersions(a, b) {
  const parts = (v) => String(v).replace(/^v/i, '').split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p < q ? -1 : 1;
    return String(p) < String(q) ? -1 : 1;
  }
  return 0;
}

let last = null; // the latest check's result, for Settings

/**
 * { version, url, newer } for the latest release, or null if GitHub couldn't
 * be reached. Throws nothing.
 */
export async function checkForUpdate() {
  try {
    const res = await fetch(API, { cache: 'no-store', headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const rel = await res.json();
    const version = String(rel.tag_name || '').replace(/^v/i, '');
    if (!version) throw new Error('no tag on the latest release');
    last = { version, url: rel.html_url || RELEASES_URL, newer: compareVersions(version, VERSION) > 0 };
    logInfo(`update check: latest is ${version}, this is ${VERSION}${last.newer ? ' (update available)' : ''}`);
    return last;
  } catch (err) {
    logInfo(`update check failed: ${err.message}`);
    return null;
  }
}

/** The last check's result (null if there hasn't been one, or it failed). */
export const lastUpdateCheck = () => last;
