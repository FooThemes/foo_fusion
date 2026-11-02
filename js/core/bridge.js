// Thin wrapper around the foo_ui_webview2 bridge (window.fb2k).
//
// - call() resolves with the result object and throws on { success: false },
//   so callers can use plain try/catch.
// - on() subscribes to a host event and returns an unsubscribe function.
// - Every failure is logged once to the console with the method name, which is
//   what shows up in the WebView2 dev tools and in Fusion's debug log.

const listeners = new Map();

function host() {
  if (!window.fb2k) throw new Error('foo_ui_webview2 bridge (window.fb2k) is not available');
  return window.fb2k;
}

export class BridgeError extends Error {
  constructor(method, message, code, details) {
    super(`${method}: ${message}`);
    this.method = method;
    this.code = code || 'UNKNOWN';
    this.details = details;
  }
}

export async function call(method, params) {
  let res;
  try {
    res = await host().invoke(method, params || {});
  } catch (err) {
    const e = new BridgeError(method, err.message || String(err), err.code);
    console.error('[fusion]', e.message);
    throw e;
  }
  if (res && res.success === false) {
    const e = new BridgeError(method, res.error || 'failed', res.code, res.details);
    // Expected "nothing here" answers are not worth a console line.
    if (!['NO_ACTIVE_ITEM', 'NOT_FOUND'].includes(e.code)) console.warn('[fusion]', e.message);
    throw e;
  }
  return res;
}

/** Like call(), but returns `fallback` instead of throwing. */
export async function tryCall(method, params, fallback = null) {
  try {
    return await call(method, params);
  } catch {
    return fallback;
  }
}

export function on(event, fn) {
  const off = host().on(event, (data) => {
    try {
      fn(data || {});
    } catch (err) {
      console.error(`[fusion] handler for ${event} failed:`, err);
    }
  });
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(off);
  return off;
}

/** Subscribe to several events with one (coalesced) handler. */
export function onAny(events, fn) {
  const offs = events.map((e) => on(e, fn));
  return () => offs.forEach((off) => off());
}
