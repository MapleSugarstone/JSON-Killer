/* UI for JSON-Killer. MIT licensed. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const drop = $('drop'), fileInput = $('file'), dropText = $('droptext');
  const statusEl = $('status'), errorEl = $('error'), resultEl = $('result');
  const statsEl = $('stats'), summaryEl = $('summary'), downloadEl = $('download');
  const rasterEl = $('rasterize'), rasterOptsEl = $('rasterOpts'), rasterReportEl = $('rasterReport');
  const rasterDocsEl = $('rasterDocs');
  const soundEl = $('sounds'), soundOptsEl = $('soundOpts'), soundReportEl = $('soundReport');
  const soundDocsEl = $('soundDocs');

  let url = null;
  let busy = false;

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
        (it.w !== undefined ? ' — ' + size(it) : '') +
        (it.why ? ' — ' + it.why : '');
      ul.appendChild(li);
    }
    p.appendChild(ul);
    return p;
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

  async function run(file) {
    if (busy) return;
    if (!window.CompressionStream || !window.DecompressionStream) {
      return fail('This browser has no CompressionStream support. Use a current Chrome, Firefox or Safari.');
    }
    busy = true;
    reset();
    dropText.textContent = file.name;
    statusEl.hidden = false;
    statusEl.textContent = 'Reading file';
    await tick();

    try {
      const buffer = await file.arrayBuffer();
      const opts = {};
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
      summaryEl.innerHTML =
        'Verified identical, ' + n(res.compared) + ' live blocks compared.<br>' +
        'project.json ' + n(res.before) + ' to ' + n(res.after) + ' bytes (' + verdict + ').';

      renderRaster(res.raster);
      renderSounds(res.sounds);

      url = URL.createObjectURL(res.blob);
      downloadEl.href = url;
      downloadEl.download = file.name.replace(/\.sb3$/i, '') + ' (shrunk).sb3';

      statusEl.hidden = true;
      resultEl.hidden = false;
    } catch (e) {
      fail(e.message || String(e), e.problems);
    } finally {
      busy = false;
    }
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
