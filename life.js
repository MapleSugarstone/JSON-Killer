/* Faint Conway's Game of Life behind the page. MIT licensed. */
(function () {
  'use strict';

  const canvas = document.getElementById('life');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const CELL = 15;
  const STEP_MS = 170;
  const MAX_DENSITY = 0.13;   // stop seeding once this full
  const SEED_CAP = 8;         // ceiling on clusters added per step
  const RAMP = 90;            // steps between budget increases, ~15s

  let w = 0, h = 0, cols = 0, rows = 0;
  let grid = null, next = null;
  let steps = 0, budget = 1, last = 0;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const at = (x, y) => y * cols + x;

  function seed(p) {
    for (let i = 0; i < grid.length; i++) if (Math.random() < p) grid[i] = 1;
  }

  // drop small clusters rather than lone cells, which just die on the next tick
  function spawn(n) {
    for (let i = 0; i < n; i++) {
      const x = 1 + ((Math.random() * (cols - 2)) | 0);
      const y = 1 + ((Math.random() * (rows - 2)) | 0);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (Math.random() < 0.5) grid[at(x + dx, y + dy)] = 1;
        }
      }
    }
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const nc = Math.ceil(w / CELL) + 1;
    const nr = Math.ceil(h / CELL) + 1;
    const old = grid, oc = cols, or = rows;
    cols = nc; rows = nr;
    grid = new Uint8Array(cols * rows);
    next = new Uint8Array(cols * rows);

    if (old) {
      for (let y = 0; y < Math.min(or, rows); y++) {
        for (let x = 0; x < Math.min(oc, cols); x++) grid[at(x, y)] = old[y * oc + x];
      }
    } else {
      seed(0.015);
    }
    draw();
  }

  function step() {
    for (let y = 0; y < rows; y++) {
      const up = ((y - 1 + rows) % rows) * cols;
      const dn = ((y + 1) % rows) * cols;
      const me = y * cols;
      for (let x = 0; x < cols; x++) {
        const l = (x - 1 + cols) % cols;
        const r = (x + 1) % cols;
        const n = grid[up + l] + grid[up + x] + grid[up + r] +
                  grid[me + l] + grid[me + r] +
                  grid[dn + l] + grid[dn + x] + grid[dn + r];
        next[me + x] = (n === 3 || (n === 2 && grid[me + x])) ? 1 : 0;
      }
    }
    const t = grid; grid = next; next = t;

    steps++;
    if (steps % RAMP === 0 && budget < SEED_CAP) budget++;

    let live = 0;
    for (let i = 0; i < grid.length; i++) live += grid[i];
    if (live / grid.length < MAX_DENSITY) spawn(budget);
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(150,170,255,0.085)';
    for (let y = 0; y < rows; y++) {
      const row = y * cols;
      for (let x = 0; x < cols; x++) {
        if (grid[row + x]) ctx.fillRect(x * CELL, y * CELL, CELL - 2, CELL - 2);
      }
    }
  }

  function frame(now) {
    if (now - last >= STEP_MS) { last = now; step(); draw(); }
    requestAnimationFrame(frame);
  }

  let t = null;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(resize, 150);
  });

  resize();
  if (!reduced) requestAnimationFrame(frame);
})();
