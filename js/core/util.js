// Small DOM and timing helpers shared by every module.

/**
 * Create an element: el('div.a.b', { onclick, title, dataset: {...} }, children...)
 * Strings become text nodes, so untrusted text is never parsed as HTML.
 */
export function el(spec, props, ...children) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'text') node.textContent = v;
      else if (k in node && typeof v !== 'string') node[k] = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(node, c);
    else node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function clear(node) {
  while (node.firstChild) node.firstChild.remove();
  return node;
}

export function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  seconds = Math.floor(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function formatDuration(seconds) {
  const total = Math.round(seconds / 60);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  return `${h} hr ${total % 60} min`;
}

export function plural(n, one, many = one + 's') {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function debounce(fn, ms) {
  let t = 0;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

/** Run fn at most once per animation frame, with the latest arguments. */
export function rafThrottle(fn) {
  let queued = false;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}

/**
 * Collapse bursts of calls into one async run; calls made during a run
 * schedule exactly one more. Option objects passed meanwhile are merged, so a
 * queued { sort: true } is not lost.
 */
export function serialize(fn) {
  let running = null;
  let queued = null;
  const run = (opts = {}) => {
    queued = { ...(queued || {}), ...opts };
    if (running) return running;
    running = (async () => {
      while (queued) {
        const next = queued;
        queued = null;
        await fn(next);
      }
    })().finally(() => (running = null));
    return running;
  };
  return run;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Stable, cheap string hash used for placeholder colours. */
export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Escape a value for a foobar2000 query string ("..." quoting). */
export function queryString(v) {
  return '"' + String(v).replace(/"/g, '') + '"';
}

/** Escape literal text for use inside a title formatting pattern. */
export function tfLiteral(v) {
  return "'" + String(v).replace(/'/g, "''") + "'";
}
