// Mirrors warnings and errors (including uncaught ones) to fusion.log in the
// foobar2000 profile folder, so problems can be diagnosed without dev tools.
// Rate-limited so a repeating error can't flood the disk.

const FILE = 'fusion.log';
let budget = 200; // lines per session

function write(level, parts) {
  if (budget <= 0 || !window.fb2k || window.fb2k.mock) return;
  budget--;
  const message = parts.map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : safeJson(p))).join(' ');
  window.fb2k.invoke('log.write', { file: FILE, level, message }).catch(() => {});
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function installLog(version) {
  const origInfo = console.info.bind(console);
  console.info = (...args) => {
    origInfo(...args);
    if (typeof args[0] === 'string' && args[0].startsWith('[fusion]')) write('info', args);
  };
  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      write(level, args);
    };
  }
  window.addEventListener('error', (e) => write('error', [`Uncaught: ${e.message} at ${e.filename}:${e.lineno}`]));
  window.addEventListener('unhandledrejection', (e) => write('error', ['Unhandled rejection:', e.reason]));
  write('info', [`Fusion ${version} started (${navigator.userAgent})`]);
}

export function logInfo(...parts) {
  write('info', parts);
}
