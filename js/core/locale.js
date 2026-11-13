// Dates and times as Windows shows them: foobar2000 is asked for the system's
// locale (the browser inside it only knows its own language, usually
// en-US). Without an answer: 24-hour times and day-month dates.

import { tryCall } from './bridge.js';
import { logInfo } from './log.js';

let loaded = null;
let tag = null; // e.g. 'en-AU'
let hour12 = null; // the system's own 12/24-hour choice, when it says

/** Ask once (later calls wait for the same answer). */
export function loadLocale() {
  return (loaded ||= tryCall('system.getLocale').then((res) => {
    logInfo('system locale', JSON.stringify(res));
    tag = pickTag(res);
    hour12 = pickHour12(res);
  }));
}

function pickTag(res) {
  const ok = (v) => typeof v === 'string' && /^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(v) && supported(v.replace('_', '-'));
  if (ok(res)) return res.replace('_', '-');
  if (!res || typeof res !== 'object') return null;
  for (const k of ['locale', 'userLocale', 'regionLocale', 'formatLocale', 'name', 'tag', 'language', 'uiLocale']) if (ok(res[k])) return res[k].replace('_', '-');
  for (const v of Object.values(res)) if (ok(v)) return v.replace('_', '-');
  return null;
}

function pickHour12(res) {
  if (!res || typeof res !== 'object') return null;
  if (typeof res.hour12 === 'boolean') return res.hour12;
  if (typeof res.is24Hour === 'boolean') return !res.is24Hour;
  // A Windows time pattern ("h:mm tt" is 12-hour, "HH:mm" 24-hour).
  const pattern = res.shortTime || res.timeFormat || res.shortTimePattern || res.longTime;
  if (typeof pattern === 'string') return /h/.test(pattern) && !/H/.test(pattern);
  return null;
}

function supported(t) {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([t]).length > 0;
  } catch {
    return false;
  }
}

const fallbackMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An hour of the day: "3 pm" or "15:00", as the system writes it. */
export function formatHour(h) {
  if (tag) {
    try {
      const d = new Date(2000, 0, 1, h);
      return new Intl.DateTimeFormat(tag, { hour: 'numeric', ...(hour12 == null ? {} : { hour12 }) }).format(d);
    } catch {
      /* the default below */
    }
  }
  return `${String(h).padStart(2, '0')}:00`;
}

/** A month: short, with a two-digit year ("Nov 26", or as the system has it). */
export function formatMonth(d) {
  if (tag) {
    try {
      return d.toLocaleDateString(tag, { month: 'short', year: '2-digit' });
    } catch {
      /* the default below */
    }
  }
  return `${fallbackMonths[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
}

/** A month in full, for tooltips ("November 2026"). */
export function formatMonthLong(d) {
  if (tag) {
    try {
      return d.toLocaleDateString(tag, { month: 'long', year: 'numeric' });
    } catch {
      /* the default below */
    }
  }
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}
