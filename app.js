/* UI for JSON-Killer. MIT licensed. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const drop = $('drop'), fileInput = $('file'), dropText = $('droptext');
  const statusEl = $('status'), errorEl = $('error'), resultEl = $('result');
  const statsEl = $('stats'), summaryEl = $('summary'), downloadEl = $('download');
  const damageEl = $('damage');
  const killEl = $('killjson');
  const rasterEl = $('rasterize'), rasterOptsEl = $('rasterOpts'), rasterReportEl = $('rasterReport');
  const rasterDocsEl = $('rasterDocs');
  const soundEl = $('sounds'), soundOptsEl = $('soundOpts'), soundReportEl = $('soundReport');
  const soundDocsEl = $('soundDocs');

  let url = null;
  let busy = false;
  // the file waiting on a decision, held so apply() does not re-read it
  let pending = null;

  const n = x => x.toLocaleString('en-US');
  const tick = () => new Promise(r => setTimeout(r, 0));

  function reset() {
    errorEl.hidden = true;
    resultEl.hidden = true;
    errorEl.textContent = '';
    if (url) { URL.revokeObjectURL(url); url = null; }
  }

  function fail(msg, problems) {
    statusEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = msg;
    if (problems && problems.length) {
      const ul = document.createElement('ul');
      for (const p of problems.slice(0, 10)) {
        const li = document.createElement('li');
        li.textContent = p;
        ul.appendChild(li);
      }
      if (problems.length > 10) {
        const li = document.createElement('li');
        li.textContent = 'and ' + (problems.length - 10) + ' more';
        ul.appendChild(li);
      }
      errorEl.appendChild(ul);
    }
  }

  /* reports for the two passes that change assets */

  const size = c => Math.round(c.w) + ' × ' + Math.round(c.h);

  // Costumes and sounds are named by their name in the project.json, never by
  // the md5 the file is stored under, which is the whole point of listing them
  // here.
  function nameList(items, label) {
    const p = document.createElement('p');
    p.textContent = items.length + ' ' + label;
    const ul = document.createElement('ul');
    ul.className = 'names';
    for (const it of items) {
      const li = document.createElement('li');
      li.textContent = it.target + ' › ' + it.name +
        (it.w !== undefined ? ' - ' + size(it) : '') +
        (it.why ? ' - ' + it.why : '');
      ul.appendChild(li);
    }
    p.appendChild(ul);
    return p;
  }

  function para(text, cls) {
    const p = document.createElement('p');
    if (cls) p.className = cls;
    p.textContent = text;
    return p;
  }

  // Every one of them, however many there are. A report that stops at a round
  // number and says "and 4 more" hides exactly the entry someone is hunting
  // for, and the whole point of this list is to be gone through.
  function bullets(items) {
    const ul = document.createElement('ul');
    ul.className = 'names';
    for (const t of items) {
      const li = document.createElement('li');
      li.textContent = t;
      ul.appendChild(li);
    }
    return ul;
  }

  // Red is code that is hidden or duplicated. Yellow runs and quietly does
  // nothing. Green is wrong in the file but never read.
  const pick = (list, lvl) => list.filter(function (d) { return d.level === lvl; });
  const worst = (high, mid) => (high.length ? 'serious' : mid.length ? 'minor' : 'cosmetic');
  const count = (a, one, many) => n(a.length) + (a.length === 1 ? one : many);

  function sections(high, mid, low, el) {
    el = el || damageEl;
    const add = (items, cls, text) => {
      if (!items.length) return;
      el.appendChild(para(text, cls));
      el.appendChild(bullets(items.map(function (d) { return d.text; })));
    };
    add(high, 'warn', count(high, ' broken link.', ' broken links.') +
      ' Code is hidden or duplicated.');
    add(mid, 'caution', count(mid, ' dead reference.', ' dead references.') +
      ' These run and do nothing.');
    add(low, 'good', count(low, ' covered reference.', ' covered references.') +
      ' Never read, no effect.');
  }

  // Damage the file arrived with. Shrinking neither causes it nor repairs it,
  // but a link that disagrees with itself is how a whole script ends up in the
  // file with nothing in the editor drawing it, and that script is exactly what
  // a delete pass is most likely to mistake for residue. Nothing is thrown away
  // unless the cleanup below is asked for by name.
  function renderDamage(res) {
    damageEl.hidden = true;
    damageEl.textContent = '';

    if (res.cleaned || res.deleted || res.fixed) return renderActions(res);

    const list = res.damaged || [];
    if (!list.length) return;
    damageEl.hidden = false;

    const high = pick(list, 'high'), mid = pick(list, 'mid'), low = pick(list, 'low');
    damageEl.className = worst(high, mid);
    sections(high, mid, low);

    damageEl.appendChild(para(high.length
      ? 'Red is yours to fix in Scratch.'
      : 'Nothing here needs doing.', 'note'));
  }

  /* the review step: choose what to do before anything slow runs */

  // Rasterizing and sound conversion take the longest and their results do not
  // depend on any of this, so the choices are made first and the whole pipeline
  // runs once afterwards. Ticking a box costs nothing, and every combination is
  // allowed, which the old one-button-per-action version could not do.
  function renderReview(pre) {
    damageEl.hidden = false;
    damageEl.textContent = '';

    const list = pre.damaged || [];
    const high = pick(list, 'high'), mid = pick(list, 'mid'), low = pick(list, 'low');
    damageEl.className = worst(high, mid);
    sections(high, mid, low);

    const box = document.createElement('div');
    box.id = 'choices';

    const option = (count, key, label, note) => {
      if (!count) return;
      const l = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.action = key;
      l.appendChild(cb);
      l.appendChild(document.createTextNode(' ' + label));
      box.appendChild(l);
      box.appendChild(para(note, 'note'));
    };

    option(pre.cleanable, 'cleanDuplicates',
      'Remove ' + n(pre.cleanable) + ' duplicated definition' + (pre.cleanable === 1 ? '' : 's'),
      'A definition whose pointers aim at another script’s blocks, plus the code under it. ' +
      'Skipped if anything surviving points into it.');

    option(pre.deletable, 'deleteDead',
      'Delete ' + n(pre.deletable) + ' block' + (pre.deletable === 1 ? '' : 's') + ' that do nothing',
      'Stack blocks whose dropdown names something the project no longer has. The script ' +
      'closes up behind them. Reporters and hats are left alone.');

    option(pre.fixable, 'fixCovered',
      'Fix ' + n(pre.fixable) + ' covered reference' + (pre.fixable === 1 ? '' : 's'),
      'Points stale owners back at the block holding them, and covered dropdowns at an ' +
      'asset that exists. Nothing executes either, so behaviour cannot change.');

    damageEl.appendChild(box);

    const wrap = document.createElement('p');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'button';
    go.textContent = 'Shrink';
    go.addEventListener('click', apply);
    wrap.appendChild(go);
    damageEl.appendChild(wrap);
    damageEl.appendChild(para(
      'Tick none of them to just shrink.'));
  }

  function chosenActions() {
    const opts = {};
    const boxes = damageEl.querySelectorAll('input[data-action]');
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].checked) opts[boxes[i].dataset.action] = true;
    }
    return opts;
  }

  function renderActions(res) {
    damageEl.hidden = false;
    let left = null;

    const c = res.cleaned;
    if (c) {
      left = c.remaining;
      damageEl.appendChild(para(c.done.length
        ? 'Removed ' + n(c.done.length) + ' duplicated definition' +
          (c.done.length === 1 ? '' : 's') + ', ' + n(c.removed) + ' blocks.'
        : 'No duplicated definition was removed.', c.done.length ? null : 'warn'));
      if (c.done.length) damageEl.appendChild(bullets(c.done.map(function (d) {
        return d.target + ' › ' + d.label + ' - ' + n(d.removed) + ' blocks';
      })));
      skips(c.skipped);
    }

    const d = res.deleted;
    if (d) {
      left = d.remaining;
      damageEl.appendChild(para(d.done.length
        ? 'Deleted ' + n(d.done.length) + ' block' + (d.done.length === 1 ? '' : 's') +
          ' that did nothing, ' + n(d.removed) + ' blocks with their dropdowns.'
        : 'Nothing was deleted.', d.done.length ? null : 'warn'));
      if (d.done.length) damageEl.appendChild(bullets(d.done.map(function (x) {
        return x.target + ' › "' + x.script + '" - ' + x.label +
               ', which named ' + x.what + ' "' + x.value + '"';
      })));
      skips(d.skipped);
    }

    const f = res.fixed;
    if (f) {
      left = f.remaining;
      damageEl.appendChild(para(f.done.length
        ? 'Fixed ' + n(f.done.length) + ' covered reference' + (f.done.length === 1 ? '' : 's') + '.'
        : 'Nothing needed fixing.', f.done.length ? null : 'warn'));
      if (f.done.length) damageEl.appendChild(bullets(f.done.map(function (x) {
        return x.target + ' › ' + x.label + ' - ' + x.what;
      })));
    }

    const rest = left || [];
    const high = pick(rest, 'high'), mid = pick(rest, 'mid'), low = pick(rest, 'low');
    damageEl.className = worst(high, mid);
    if (rest.length) {
      damageEl.appendChild(para('Still in the file:', 'note'));
      sections(high, mid, low);
    } else {
      damageEl.appendChild(para('Nothing else is wrong with the file.', 'note'));
    }
  }

  function skips(list) {
    if (!list || !list.length) return;
    damageEl.appendChild(para('Left alone, a check did not pass:', 'warn'));
    damageEl.appendChild(bullets(list.map(function (s) {
      return s.target + ' › ' + s.label + ' - ' + s.why;
    })));
  }

  function renderRaster(r) {
    rasterReportEl.hidden = true;
    rasterReportEl.textContent = '';
    if (!r) return;
    rasterReportEl.hidden = false;

    const head = document.createElement('p');
    head.textContent = r.total === 0
      ? 'No svg costumes to rasterize.'
      : 'Rasterized ' + n(r.converted) + ' of ' + n(r.total) + ' svg costumes at ' +
        r.scale + '×, ' + (r.antialias ? 'anti-aliased' : 'aliased') +
        (r.sample > 1 ? ', supersampled ' + r.sample + '×' : '') + '. ' +
        n(r.assets) + ' png written, assets ' + n(r.bytesBefore) + ' to ' +
        n(r.bytesAfter) + ' bytes.';
    rasterReportEl.appendChild(head);

    if (r.tooBig.length) {
      rasterReportEl.appendChild(nameList(r.tooBig, 'left as svg, bigger than the 480 × 360 stage:'));
    }
    if (r.failed.length) {
      rasterReportEl.appendChild(nameList(r.failed, 'left as svg, could not be rasterized:'));
    }
    if (r.text.length) {
      rasterReportEl.appendChild(nameList(r.text, 'contain text, redrawn in this browser’s fonts. Check them:'));
    }
  }

  function renderSounds(r) {
    soundReportEl.hidden = true;
    soundReportEl.textContent = '';
    if (!r) return;
    soundReportEl.hidden = false;

    const head = document.createElement('p');
    head.textContent = r.total === 0
      ? 'No sounds to convert.'
      : 'Converted ' + n(r.converted) + ' of ' + n(r.total) + ' sounds to mono ' +
        r.kbps + ' kbps mp3. ' + n(r.assets) + ' mp3 written, assets ' +
        n(r.bytesBefore) + ' to ' + n(r.bytesAfter) + ' bytes.';
    soundReportEl.appendChild(head);

    if (r.kept.length) {
      soundReportEl.appendChild(nameList(r.kept, 'left alone, already smaller than an mp3 of them:'));
    }
    if (r.failed.length) {
      soundReportEl.appendChild(nameList(r.failed, 'left alone, could not be converted:'));
    }
  }

  // Nothing about either extra pass is on the page until it is switched on: not
  // the settings, not the write up under Method. The initial calls matter
  // because a browser restores a ticked box across a reload without firing
  // change.
  function paintRasterUi() {
    rasterOptsEl.hidden = !rasterEl.checked;
    rasterDocsEl.hidden = !rasterEl.checked;
  }
  rasterEl.addEventListener('change', paintRasterUi);
  paintRasterUi();

  // 156 kB of encoder that most visitors never need, so it is fetched the first
  // time the box is ticked rather than on every page load.
  let lame = null;
  function loadLame() {
    if (!lame) {
      lame = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'lame.min.js';
        s.onload = res;
        s.onerror = () => { lame = null; rej(new Error('lame.min.js could not be loaded.')); };
        document.head.appendChild(s);
      });
    }
    return lame;
  }

  function paintSoundUi() {
    soundOptsEl.hidden = !soundEl.checked;
    soundDocsEl.hidden = !soundEl.checked;
    // start the fetch on the tick, so it is usually done by the time a file
    // arrives. run() waits on the same promise either way.
    if (soundEl.checked) loadLame().catch(function () {});
  }
  soundEl.addEventListener('change', paintSoundUi);
  paintSoundUi();

  // Read, look for damage, and stop there if there is anything to decide. The
  // slow passes are not touched until apply() runs, so choosing costs nothing
  // and no work is ever repeated.
  async function run(file) {
    if (busy) return;
    if (!window.CompressionStream || !window.DecompressionStream) {
      return fail('This browser has no CompressionStream support. Use a current Chrome, Firefox or Safari.');
    }
    if (!killEl.checked && !rasterEl.checked && !soundEl.checked) {
      reset();
      dropText.textContent = file.name;
      return fail('No features enabled. Tick at least one of the boxes above.');
    }
    busy = true;
    reset();
    dropText.textContent = file.name;
    statusEl.hidden = false;
    statusEl.textContent = 'Reading file';
    await tick();

    try {
      const buffer = await file.arrayBuffer();
      pending = { file: file, buffer: buffer };

      // Looking for damage means walking every block in the project, which is
      // only worth doing for someone who is going to act on it. With the json
      // left alone there is nothing here to act on, so the walk is skipped.
      if (!killEl.checked) return await finish({});

      statusEl.textContent = 'Checking the project';
      await tick();
      const pre = await SB3.analyse(buffer);

      if (pre.cleanable || pre.deletable || pre.fixable) {
        statusEl.hidden = true;
        chrome(false);
        resultEl.hidden = false;
        renderReview(pre);
        return;
      }
      await finish({});
    } catch (e) {
      fail(e.message || String(e), e.problems);
    } finally {
      busy = false;
    }
  }

  async function apply() {
    if (busy || !pending) return;
    busy = true;
    statusEl.hidden = false;
    statusEl.textContent = 'Starting';
    await tick();
    try {
      await finish(chosenActions());
    } catch (e) {
      fail(e.message || String(e), e.problems);
    } finally {
      busy = false;
    }
  }

  // stats, summary and the download link are meaningless during the review
  function chrome(on) {
    statsEl.hidden = !on;
    summaryEl.hidden = !on;
    downloadEl.hidden = !on;
  }

  async function finish(actions) {
    const file = pending.file, buffer = pending.buffer;
    const opts = Object.assign({}, actions);
    opts.shrink = killEl.checked;
    if (rasterEl.checked) {
      opts.rasterize = RASTER.pass({
        scale: Number($('rasterScale').value),
        supersample: Number($('rasterSample').value),
        antialias: $('rasterAA').checked
      });
    }
    if (soundEl.checked) {
      statusEl.textContent = 'Loading the mp3 encoder';
      await tick();
      await loadLame();
      opts.sounds = SOUND.pass({ kbps: Number($('soundKbps').value) });
    }

    const res = await SB3.process(buffer, opts, async msg => {
      statusEl.textContent = msg;
      await tick();
    });

    statsEl.innerHTML = '';
    const rows = Object.keys(res.stats).sort((a, b) => res.stats[b] - res.stats[a]);
    for (const k of rows) {
      const tr = statsEl.insertRow();
      tr.insertCell().textContent = k;
      tr.insertCell().textContent = n(res.stats[k]);
    }

    // Rasterizing writes a bitmapResolution back onto every costume it
    // touches, so on that path the json can come out bigger than it went in.
    const saved = res.before - res.after;
    const pct = res.before ? (100 * Math.abs(saved) / res.before).toFixed(1) : '0.0';
    const verdict = saved < 0
      ? '<b class="bad">' + n(-saved) + ' added, ' + pct + '%</b>'
      : '<b>' + n(saved) + ' saved, ' + pct + '%</b>';
    // With cleanup on, the output is deliberately not the project that came
    // in, so say what it was checked against instead of implying otherwise.
    const wiped = (res.cleaned && res.cleaned.removed) ||
                  (res.deleted && res.deleted.removed) ||
                  (res.fixed && res.fixed.fixed);
    // Claiming a check that never ran would be the one lie this page cannot
    // afford. "untouched" was also wrong: rasterizing and sound conversion
    // rewrite the costume and sound entries, so the json does change on those
    // paths. What is true is only that no shrinking pass ran.
    const checked = !killEl.checked
      ? 'No Killing done.'
      : (wiped ? 'Verified identical to the cleaned project, ' : 'Verified identical, ') +
        n(res.compared) + ' live blocks compared.';
    summaryEl.innerHTML = checked + '<br>' +
      'project.json ' + n(res.before) + ' to ' + n(res.after) + ' bytes (' + verdict + ').';

    renderDamage(res);
    renderRaster(res.raster);
    renderSounds(res.sounds);

    url = URL.createObjectURL(res.blob);
    downloadEl.href = url;
    downloadEl.download = file.name.replace(/\.sb3$/i, '') +
      (!killEl.checked ? ' (converted).sb3'
       : wiped ? ' (shrunk, cleaned).sb3' : ' (shrunk).sb3');

    chrome(true);
    statusEl.hidden = true;
    resultEl.hidden = false;
  }

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) run(fileInput.files[0]);
  });

  drop.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });

  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => {
    e.preventDefault();
    drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => {
    e.preventDefault();
    drop.classList.remove('over');
  }));
  drop.addEventListener('drop', e => {
    const f = e.dataTransfer.files[0];
    if (f) run(f);
  });

  /* music */
  const audio = $('music'), toggle = $('musicToggle');
  const KEY = 'jk-music-v2';
  audio.volume = 0.35;
  let wanted = localStorage.getItem(KEY) !== 'off';

  // The label tracks real playback, not intent. Autoplay is blocked until the
  // page has been interacted with, so intent and reality disagree on load, and
  // a button that claims "off" has to actually turn the music on when clicked.
  function paint() {
    const on = !audio.paused;
    toggle.textContent = 'Music: ' + (on ? 'on' : 'off');
    toggle.setAttribute('aria-pressed', String(on));
  }

  function tryPlay() {
    if (!wanted || !audio.paused) return;
    audio.play().then(paint, function () {});
  }

  toggle.addEventListener('click', function () {
    // a click is a user gesture, so this play() is allowed through
    if (audio.paused) { wanted = true; audio.play().then(paint, paint); }
    else { wanted = false; audio.pause(); }
    localStorage.setItem(KEY, wanted ? 'on' : 'off');
    paint();
  });

  audio.addEventListener('play', paint);
  audio.addEventListener('pause', paint);

  // Autoplay with sound is blocked until the visitor interacts, so keep
  // retrying on each gesture until one is let through. Ignore gestures on the
  // toggle itself, or it would start the track and the click would stop it.
  const GESTURES = ['pointerdown', 'keydown', 'touchstart'];
  function onGesture(e) {
    if (e.target && e.target.closest && e.target.closest('#musicToggle')) return;
    tryPlay();
    if (!audio.paused) GESTURES.forEach(g => window.removeEventListener(g, onGesture));
  }
  GESTURES.forEach(g => window.addEventListener(g, onGesture, { passive: true }));

  tryPlay();
  paint();
})();
