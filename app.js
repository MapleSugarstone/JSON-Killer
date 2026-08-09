/* UI for JSON-Killer. MIT licensed. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const drop = $('drop'), fileInput = $('file'), dropText = $('droptext');
  const statusEl = $('status'), errorEl = $('error'), resultEl = $('result');
  const statsEl = $('stats'), summaryEl = $('summary'), downloadEl = $('download');

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
      const opts = { keepNext: $('keepNext').checked, dropSvgBitmapRes: $('svgRes').checked };

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

      const saved = res.before - res.after;
      const pct = res.before ? (100 * saved / res.before).toFixed(1) : '0.0';
      summaryEl.innerHTML =
        'Verified identical, ' + n(res.compared) + ' live blocks compared.<br>' +
        'project.json ' + n(res.before) + ' to ' + n(res.after) + ' bytes ' +
        '(<b>' + n(saved) + ' saved, ' + pct + '%</b>).';

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
