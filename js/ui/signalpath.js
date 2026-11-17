// The signal path in the play bar: a dot coloured by grade (as Roon's) after
// the song's length, opening a panel of the stages from the file to the
// device. Data: data/signalpath.js.

import { el, clear } from '../core/util.js';
import { icon } from '../core/icons.js';
import { signalPath, QUALITY } from '../data/signalpath.js';
import { runMainMenuAny } from './menus.js';

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
    if (p.hasEq) foot.unshift(el('button.sp-action', { type: 'button', onclick: () => runMainMenuAny(['View/Equalizer', 'View/DSP/Equalizer', 'Equalizer']) }, glyph('eq'), el('span', { text: 'Open the equalizer' })));
    pop.append(
      el('div.sp-head', null, el('span.sp-title', { text: 'Signal path: ' }), el('span.sp-grade', { text: q.label }), el('span.sp-dot', { dataset: { q: p.quality } })),
      el('p.sp-sub', { text: q.note }),
      // Only what touches this song: inactive and bypassed stages are left out.
      el('ol.sp-stages', null, ...p.stages.filter((st) => !st.idle && !st.hidden).map(stage)),
      ...foot,
    );
  }
  // A stage: its symbol on the line, name, detail and note.
  function stage(s) {
    return el(
      'li.sp-stage' + (s.idle ? '.idle' : ''),
      { title: s.note || '' },
      el('span.sp-node', null, glyph(s.icon)),
      el('div.sp-text', null, el('div.sp-name', null, el('span', { text: s.title }), el('span.sp-dot', { dataset: { q: s.grade } })), el('div.sp-detail', { text: s.detail || '' }), s.note ? el('div.sp-note', { text: s.note }) : null),
    );
  }


  signalPath.on('change', render);
  signalPath.init();
}
