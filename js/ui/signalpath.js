// The signal path in the play bar: a dot coloured by grade (as Roon's) after
// the song's length, opening a panel of the stages from the file to the
// device. Data: data/signalpath.js.

import { el, clear } from '../core/util.js';
import { icon } from '../core/icons.js';
import { signalPath, QUALITY } from '../data/signalpath.js';
import { runMainMenuAny } from './menus.js';

const openEq = () => runMainMenuAny(['View/Equalizer', 'View/DSP/Equalizer', 'Equalizer']);

/**
 * What clicking a step opens: only where it lands on the step's own
 * controls. (Preferences can't be opened at a page from here, so ReplayGain,
 * the output and the other DSPs have none.)
 */
function stageAction(s) {
  if (s.kind === 'volume') return { label: 'the volume', run: () => window.dispatchEvent(new CustomEvent('fusion:showvolume')) };
  if (s.kind === 'dsp' && s.icon === 'eq') return { label: 'the equalizer', run: openEq };
  return null;
}

// Small symbols for the stages (drawn here: not in the icon set).
const GLYPH = {
  lossless: 'M4 7h3M4 12h5M4 17h3M12 5v14M16 8v8M20 10v4',
  lossy: 'M4 12h2M8 9v6M12 6v12M16 9v6M20 12h-2',
  gain: 'M4 18 20 6M6 6h4M8 4v4M14 18h4',
  dsp: 'M5 4v16M12 4v16M19 4v16M3 9h4M10 15h4M17 7h4',
  resample: 'M4 16c3 0 3-8 6-8s3 8 6 8 3-8 4-8M4 20h16',
  output: 'M5 9h4l5-4v14l-5-4H5zM17 9a4 4 0 0 1 0 6',
  volume: 'M4 9h3l4-4v14l-4-4H4zM15 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10',
  windows: 'M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z',
  check: 'M4 12.5 9.5 18 20 6',
  eq: 'M4 20v-6M8 20V8M12 20v-9M16 20V5M20 20v-7M3 20h18',
  // A wave held between two ceilings.
  limiter: 'M3 6h18M3 18h18M4 12c2-5 4-5 5 0s3 5 5 0 3-5 5 0',
  // Several channels into fewer, and fewer into several.
  downmix: 'M4 4l8 8M20 4l-8 8M12 12v8M9 17l3 3 3-3',
  upmix: 'M12 20v-8M12 12 5 5M12 12l7-7M5 9V5h4M19 9V5h-4',
  rear: 'M12 4v11M8 11l4 4 4-4M5 20h14',
  swap: 'M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4',
  skip: 'M5 6l8 6-8 6zM17 6v12',
  // Two channels leaning into each other; two songs overlapping.
  crossfeed: 'M5 6v12M19 6v12M5 9c5 0 9 6 14 6M5 15c5 0 9-6 14-6',
  crossfade: 'M3 18 12 6M12 18 21 6M3 18h18',
};
const glyph = (name) => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'sp-glyph');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', GLYPH[name] || GLYPH.dsp);
  svg.append(path);
  return svg;
};

export function mountSignalPath(controls, root) {
  const dot = el('span.sp-dot');
  const chip = el('button.sp-chip', { type: 'button', hidden: true, onclick: (e) => (e.stopPropagation(), toggle()) }, dot);
  controls.prepend(chip);
  const pop = el('div.sp-pop', { hidden: true, role: 'dialog', 'aria-label': 'Signal path' });
  root.append(pop);

  function toggle(show = pop.hidden) {
    pop.hidden = !show;
    chip.classList.toggle('on', show);
    if (show) {
      render();
      signalPath.refresh();
    }
  }
  document.addEventListener('pointerdown', (e) => !pop.hidden && !pop.contains(e.target) && !chip.contains(e.target) && toggle(false));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !pop.hidden && toggle(false));

  function render() {
    const p = signalPath.path;
    chip.hidden = !p;
    if (!p) {
      if (!pop.hidden) toggle(false);
      return;
    }
    const q = QUALITY[p.quality];
    chip.dataset.q = p.quality;
    chip.title = `Signal path: ${q.label}`;
    if (pop.hidden) return;
    clear(pop);
    const foot = p.outputInfo ? [] : [el('p.sp-foot', null, icon('info'), el('span', { text: 'Install foo_outinfo to show the output format and applied ReplayGain.' }))];
    // foobar2000's Equalizer in the chain: its window, one click away.
    if (p.hasEq) foot.unshift(el('button.sp-action', { type: 'button', onclick: openEq }, glyph('eq'), el('span', { text: 'Open the equalizer' })));
    const was = pop.querySelector('.sp-scroll')?.scrollTop || 0;
    pop.append(
      // The heading stays at the top while a long chain scrolls under it.
      el('div.sp-top', null, el('div.sp-head', null, el('span.sp-title', { text: 'Signal path: ' }), el('span.sp-grade', { text: q.label }), el('span.sp-dot', { dataset: { q: p.quality } })), el('p.sp-sub', { text: q.note })),
      el('div.sp-scroll', null,
      // Only what touches this song: inactive and bypassed stages are left out.
      el('ol.sp-stages', null, ...p.stages.filter((st) => !st.idle && !st.hidden).map(stage)),
      ...foot,
      ),
    );
    const scroll = pop.querySelector('.sp-scroll');
    scroll.scrollTop = was;
    // A faint edge under the heading once the steps scroll beneath it.
    const edge = () => pop.querySelector('.sp-top')?.classList.toggle('scrolled', scroll.scrollTop > 0);
    scroll.addEventListener('scroll', edge, { passive: true });
    edge();
  }
  // A stage: its symbol on the line, name, detail and note.
  function stage(s) {
    const act = stageAction(s);
    const run = () => {
      toggle(false);
      act.run();
    };
    return el(
      'li.sp-stage' + (s.idle ? '.idle' : '') + (act ? '.sp-link' : ''),
      act
        ? { title: (s.note ? s.note + '\n\n' : '') + `Click to open ${act.label}`, tabindex: 0, role: 'button', onclick: run, onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), run()) }
        : { title: s.note || '' },
      el('span.sp-node', null, glyph(s.icon)),
      el('div.sp-text', null, el('div.sp-name', null, el('span', { text: s.title }), el('span.sp-dot', { dataset: { q: s.grade } })), el('div.sp-detail', { text: s.detail || '' }), s.note ? el('div.sp-note', { text: s.note }) : null),
    );
  }


  signalPath.on('change', render);
  signalPath.init();
}
