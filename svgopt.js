/*
 * Simplifies svg costumes: fewer vertices in the ones that have too many, and
 * the shapes hidden behind other shapes taken out. Optional, and like
 * rasterize.js it needs the DOM, for two different reasons.
 *
 * The first is geometry. A costume is measured the way scratch-vm measures it,
 * which means getBBox, which means the document has to lay the svg out. If
 * simplifying moves that box the costume changes size and place on the stage,
 * so the box is checked after every edit and anything that moves it is put
 * back.
 *
 * The second is the check. Every claim this file makes about what is hidden
 * is settled by drawing it. The original is rasterized once, and nothing is
 * removed unless the drawing without it comes out the same pixels. That is a
 * weaker promise than sb3shrink's block by block compare, because it is only
 * as true as the resolution it was checked at, but it is a promise that can
 * actually be kept: no amount of reasoning about winding rules and paint order
 * beats asking the renderer.
 *
 * MIT licensed. See LICENSE.
 */
const SVGOPT = (function () {
  'use strict';

  // Rendering the check at exactly costume size would only prove the costume is
  // unchanged at 100%, and a sprite can be scaled up. Everything is drawn
  // bigger than it will ever be shown, capped so a large costume cannot ask for
  // a canvas the browser refuses to make.
  const VERIFY_SCALE = 3;
  const MAX_SIDE = 1400;

  /* ------------------------------------------------------------- numbers */

  function round(v, prec) {
    if (typeof v !== 'number' || !isFinite(v)) return 0;
    const f = Math.pow(10, prec);
    const r = Math.round(v * f) / f;
    return Object.is(r, -0) ? 0 : r;
  }

  // The value is already rounded, so String gives the shortest text that reads
  // back as the same number. The rest is the two characters svg lets a path
  // drop: the zero in front of a decimal point, and the sign on negative zero.
  function fmt(v) {
    let s = String(v);
    if (s.indexOf('e') >= 0 || s.indexOf('E') >= 0) {
      s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    }
    if (s.slice(0, 2) === '0.') s = s.slice(1);
    else if (s.slice(0, 3) === '-0.') s = '-' + s.slice(2);
    if (s === '-0') s = '0';
    return s;
  }

  /* ---------------------------------------------------------- path data */

  const NUM = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;
  const ARGC = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

  // Returns null for anything it does not fully understand, and the caller then
  // leaves that path exactly as it found it. A path this cannot read is a path
  // it has no business rewriting.
  function parsePath(d) {
    if (typeof d !== 'string' || !d.length) return null;
    const n = d.length;
    let i = 0;
    const out = [];
    let cmd = null;

    const skip = () => {
      while (i < n && (d[i] === ',' || d.charCodeAt(i) <= 32)) i++;
    };
    const number = () => {
      skip();
      NUM.lastIndex = i;
      const m = NUM.exec(d);
      if (!m || m.index !== i) return null;
      i = NUM.lastIndex;
      return parseFloat(m[0]);
    };
    // The arc flags are the one place svg lets a number run into the next one
    // without a separator, so "a1 1 0 011 1" is five numbers and two flags, not
    // four numbers. Read as a number, the 011 would swallow both.
    const flag = () => {
      skip();
      if (d[i] === '0') { i++; return 0; }
      if (d[i] === '1') { i++; return 1; }
      return null;
    };

    while (true) {
      skip();
      if (i >= n) break;
      const ch = d[i];
      if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) {
        if (!(ch.toUpperCase() in ARGC)) return null;
        // A path has to open with a moveto. One that does not is an error, and
        // an error renders as nothing at all, so reading it as though it began
        // at the origin would put ink on the costume that was never there.
        if (cmd === null && ch !== 'M' && ch !== 'm') return null;
        cmd = ch;
        i++;
        if (ch === 'Z' || ch === 'z') { out.push({ c: ch, a: [] }); continue; }
      } else {
        if (cmd === null) return null;
        const up = cmd.toUpperCase();
        if (up === 'Z') return null;
        // A repeated moveto is a lineto. Every other command just repeats.
        if (up === 'M') cmd = (cmd === 'M') ? 'L' : 'l';
      }

      const up = cmd.toUpperCase();
      const a = [];
      if (up === 'A') {
        for (const read of [number, number, number, flag, flag, number, number]) {
          const v = read();
          if (v === null) return null;
          a.push(v);
        }
      } else {
        for (let k = 0; k < ARGC[up]; k++) {
          const v = number();
          if (v === null) return null;
          a.push(v);
        }
      }
      out.push({ c: cmd, a: a });
    }
    return out.length ? out : null;
  }

  // Everything becomes absolute, H/V become L, S/T become C/Q. One shape of
  // segment to simplify instead of ten, and the emitter puts the shorthand back
  // afterwards wherever it fits, which it can decide better than the file did.
  function normalize(cmds) {
    const subs = [];
    let sub = null;
    let x = 0, y = 0, sx = 0, sy = 0;
    let lastC = null, lastQ = null;

    const open = () => {
      sub = { x: x, y: y, segs: [], closed: false };
      subs.push(sub);
    };

    for (const s of cmds) {
      const up = s.c.toUpperCase();
      const rel = s.c !== up;
      const a = s.a;

      if (up === 'M') {
        x = rel ? x + a[0] : a[0];
        y = rel ? y + a[1] : a[1];
        sx = x; sy = y;
        open();
        lastC = lastQ = null;
        continue;
      }
      if (up === 'Z') {
        if (sub) sub.closed = true;
        x = sx; y = sy;
        lastC = lastQ = null;
        // A subpath after a close with no moveto starts again at the same point
        sub = null;
        continue;
      }
      if (!sub) { sx = x; sy = y; open(); }

      if (up === 'L' || up === 'H' || up === 'V') {
        if (up === 'H') x = rel ? x + a[0] : a[0];
        else if (up === 'V') y = rel ? y + a[0] : a[0];
        else { x = rel ? x + a[0] : a[0]; y = rel ? y + a[1] : a[1]; }
        sub.segs.push({ t: 'L', x: x, y: y });
        lastC = lastQ = null;
      } else if (up === 'C' || up === 'S') {
        let x1, y1, x2, y2;
        if (up === 'C') {
          x1 = rel ? x + a[0] : a[0]; y1 = rel ? y + a[1] : a[1];
          x2 = rel ? x + a[2] : a[2]; y2 = rel ? y + a[3] : a[3];
          x = rel ? x + a[4] : a[4]; y = rel ? y + a[5] : a[5];
        } else {
          x1 = lastC ? 2 * x - lastC.x : x;
          y1 = lastC ? 2 * y - lastC.y : y;
          x2 = rel ? x + a[0] : a[0]; y2 = rel ? y + a[1] : a[1];
          x = rel ? x + a[2] : a[2]; y = rel ? y + a[3] : a[3];
        }
        sub.segs.push({ t: 'C', x1: x1, y1: y1, x2: x2, y2: y2, x: x, y: y });
        lastC = { x: x2, y: y2 };
        lastQ = null;
      } else if (up === 'Q' || up === 'T') {
        let x1, y1;
        if (up === 'Q') {
          x1 = rel ? x + a[0] : a[0]; y1 = rel ? y + a[1] : a[1];
          x = rel ? x + a[2] : a[2]; y = rel ? y + a[3] : a[3];
        } else {
          x1 = lastQ ? 2 * x - lastQ.x : x;
          y1 = lastQ ? 2 * y - lastQ.y : y;
          x = rel ? x + a[0] : a[0]; y = rel ? y + a[1] : a[1];
        }
        sub.segs.push({ t: 'Q', x1: x1, y1: y1, x: x, y: y });
        lastQ = { x: x1, y: y1 };
        lastC = null;
      } else if (up === 'A') {
        x = rel ? x + a[5] : a[5];
        y = rel ? y + a[6] : a[6];
        sub.segs.push({ t: 'A', rx: a[0], ry: a[1], rot: a[2], laf: a[3], sf: a[4], x: x, y: y });
        lastC = lastQ = null;
      }
    }
    return subs;
  }

  /* ------------------------------------------------------------ emitting */

  function omittable(letter, last) {
    if (!last) return false;
    if (letter === last) return true;
    // "M0 0 4 4" is a moveto and then a lineto, so the L after an M is free
    return (last === 'M' && letter === 'L') || (last === 'm' && letter === 'l');
  }

  function emit(subs) {
    let out = '';
    let lastLetter = '';
    let lastWasNum = false;
    let lastNumStr = '';

    // Two numbers only need something between them when running them together
    // would read as one number. A minus sign is its own separator, and so is a
    // decimal point once the number before it has already spent one.
    function build(letter, nums) {
      let s = '';
      let wasNum = lastWasNum;
      let numStr = lastNumStr;
      const omit = omittable(letter, lastLetter);
      if (!omit) { s += letter; wasNum = false; }
      for (let i = 0; i < nums.length; i++) {
        const t = fmt(nums[i]);
        if (wasNum) {
          const glued = t[0] === '-' ||
            (t[0] === '.' && numStr.indexOf('.') >= 0 && numStr.indexOf('e') < 0);
          if (!glued) s += ' ';
        }
        s += t;
        wasNum = true;
        numStr = t;
      }
      return { s: s, wasNum: wasNum, numStr: numStr };
    }

    function put(letter, nums) {
      const r = build(letter, nums);
      out += r.s;
      lastLetter = letter;
      lastWasNum = r.wasNum;
      lastNumStr = r.numStr;
    }

    // Absolute or relative, whichever writes shorter here. Which one wins
    // depends on the command letter already standing, so it is decided per
    // segment rather than per path.
    function pick(absLetter, absNums, relLetter, relNums) {
      const a = build(absLetter, absNums);
      const b = build(relLetter, relNums);
      if (b.s.length < a.s.length) put(relLetter, relNums);
      else put(absLetter, absNums);
    }

    for (const sub of subs) {
      if (!sub.segs.length && !sub.closed) continue;
      put('M', [sub.x, sub.y]);
      let cx = sub.x, cy = sub.y;

      for (const s of sub.segs) {
        if (s.t === 'L') {
          if (s.y === cy && s.x !== cx) pick('H', [s.x], 'h', [s.x - cx]);
          else if (s.x === cx && s.y !== cy) pick('V', [s.y], 'v', [s.y - cy]);
          else pick('L', [s.x, s.y], 'l', [s.x - cx, s.y - cy]);
        } else if (s.t === 'C') {
          pick('C', [s.x1, s.y1, s.x2, s.y2, s.x, s.y],
               'c', [s.x1 - cx, s.y1 - cy, s.x2 - cx, s.y2 - cy, s.x - cx, s.y - cy]);
        } else if (s.t === 'Q') {
          pick('Q', [s.x1, s.y1, s.x, s.y],
               'q', [s.x1 - cx, s.y1 - cy, s.x - cx, s.y - cy]);
        } else {
          pick('A', [s.rx, s.ry, s.rot, s.laf, s.sf, s.x, s.y],
               'a', [s.rx, s.ry, s.rot, s.laf, s.sf, s.x - cx, s.y - cy]);
        }
        cx = s.x; cy = s.y;
      }

      if (sub.closed) { out += 'z'; lastLetter = ''; lastWasNum = false; }
    }
    return out;
  }

  /* ----------------------------------------------------------- geometry */

  function distToSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function bez(p0, p1, p2, p3, t) {
    const m = 1 - t;
    const a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
    return {
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
    };
  }

  function rdp(pts, tol) {
    const n = pts.length;
    if (n < 3) return pts.slice();
    const mark = new Uint8Array(n);
    mark[0] = mark[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const seg = stack.pop();
      const a = seg[0], b = seg[1];
      let best = -1, bd = tol;
      for (let i = a + 1; i < b; i++) {
        const d = distToSeg(pts[i], pts[a], pts[b]);
        if (d > bd) { bd = d; best = i; }
      }
      if (best >= 0) { mark[best] = 1; stack.push([a, best], [best, b]); }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (mark[i]) out.push(pts[i]);
    return out;
  }

  /* ------------------------------------------------- curve chain fitting */

  // Samples a run of cubics into points, so a fitted replacement can be
  // measured against the shape the run actually draws rather than against its
  // control points, which say very little about where the ink lands. Long runs
  // are sampled thinner per segment: what is being measured is the shape of the
  // whole run, and a few hundred points describe it whatever it is made of.
  function sampleChain(start, segs, budget) {
    const per = Math.max(2, Math.min(8, Math.floor(budget / segs.length)));
    const pts = [{ x: start.x, y: start.y }];
    let p0 = start;
    for (const s of segs) {
      const c1 = { x: s.x1, y: s.y1 }, c2 = { x: s.x2, y: s.y2 }, p3 = { x: s.x, y: s.y };
      for (let k = 1; k <= per; k++) pts.push(bez(p0, c1, c2, p3, k / per));
      p0 = p3;
    }
    return pts;
  }

  // Distance from every point of one polyline to the nearest point anywhere on
  // the other, both ways round. Comparing the two at equal parameter instead is
  // what the textbook fit does, and it is wrong for this: a long arc and its
  // replacement can trace the same line while running along it at different
  // speeds, and scoring that mismatch as error rejects the merges worth making.
  //
  // Nearest point on the nearest segment, not the nearest sample. Measuring to
  // samples puts a floor of half the sample spacing under every answer, which
  // at any sane sample count is larger than the tolerances this pass is asked
  // for, so every merge would be refused for an error that is not there.
  function apart(A, B) {
    let worst = 0;
    for (const p of A) {
      let best = Infinity;
      for (let i = 0; i + 1 < B.length; i++) {
        const d = distToSeg(p, B[i], B[i + 1]);
        if (d < best) best = d;
      }
      if (best > worst) worst = best;
    }
    return worst;
  }

  function unit(dx, dy) {
    const l = Math.hypot(dx, dy);
    return l > 1e-12 ? { x: dx / l, y: dy / l } : null;
  }

  // Schneider's least squares fit for one cubic through a set of points with
  // the end tangents held fixed, which is what keeps the joins with the
  // untouched neighbours smooth.
  function fitCubic(pts, t1, t2) {
    const n = pts.length;
    const u = [0];
    for (let i = 1; i < n; i++) {
      u.push(u[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    }
    const total = u[n - 1];
    if (!(total > 0)) return null;
    for (let i = 0; i < n; i++) u[i] /= total;

    const p0 = pts[0], p3 = pts[n - 1];
    let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
    for (let i = 0; i < n; i++) {
      const t = u[i], m = 1 - t;
      const b0 = m * m * m, b1 = 3 * m * m * t, b2 = 3 * m * t * t, b3 = t * t * t;
      const a0x = t1.x * b1, a0y = t1.y * b1;
      const a1x = t2.x * b2, a1y = t2.y * b2;
      c00 += a0x * a0x + a0y * a0y;
      c01 += a0x * a1x + a0y * a1y;
      c11 += a1x * a1x + a1y * a1y;
      const tx = pts[i].x - (p0.x * (b0 + b1) + p3.x * (b2 + b3));
      const ty = pts[i].y - (p0.y * (b0 + b1) + p3.y * (b2 + b3));
      x0 += a0x * tx + a0y * ty;
      x1 += a1x * tx + a1y * ty;
    }
    const det = c00 * c11 - c01 * c01;
    let a1 = 0, a2 = 0;
    if (Math.abs(det) > 1e-12) {
      a1 = (x0 * c11 - x1 * c01) / det;
      a2 = (c00 * x1 - c01 * x0) / det;
    }
    // A negative or absurd magnitude means the fit ran away. The chord third is
    // the standard fallback and is always a sane curve.
    const chord = Math.hypot(p3.x - p0.x, p3.y - p0.y);
    if (!(a1 > 1e-9) || !(a2 > 1e-9) || a1 > chord * 3 || a2 > chord * 3) {
      a1 = a2 = chord / 3;
    }
    const c1 = { x: p0.x + t1.x * a1, y: p0.y + t1.y * a1 };
    const c2 = { x: p3.x + t2.x * a2, y: p3.y + t2.y * a2 };

    // Both directions. One way round alone would let a curve that overshoots
    // past the shape score clean, since every original point still has
    // something near it.
    const cand = [];
    const m = Math.max(24, Math.min(96, n));
    for (let k = 0; k <= m; k++) cand.push(bez(p0, c1, c2, p3, k / m));
    const err = Math.max(apart(pts, cand), apart(cand, pts));
    return { c1: c1, c2: c2, err: err };
  }

  /* ------------------------------------------------------ path simplify */

  function same(a, b, eps) {
    return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
  }

  function simplifySub(sub, tol, prec) {
    const eps = Math.pow(10, -prec) / 2;

    // Lossless still means the rounding has already moved every coordinate by
    // up to half a step, so allowing exactly that much movement here changes
    // nothing that was not changed a moment ago. What it buys is the vertices
    // that are redundant no matter how strict the setting: a point sitting on
    // the line between its neighbours, a curve that is already straight, a
    // duplicate. Skipping the work entirely at zero left those in, which made
    // the lossless setting remove no vertices at all.
    const move = tol > 0 ? tol : eps;

    // Round first. Half the vertices in a brush stroke differ from their
    // neighbour only in float noise, and once that is gone the steps below can
    // see them for the duplicates they are.
    sub.x = round(sub.x, prec);
    sub.y = round(sub.y, prec);
    for (const s of sub.segs) {
      s.x = round(s.x, prec); s.y = round(s.y, prec);
      if (s.t === 'C') {
        s.x1 = round(s.x1, prec); s.y1 = round(s.y1, prec);
        s.x2 = round(s.x2, prec); s.y2 = round(s.y2, prec);
      } else if (s.t === 'Q') {
        s.x1 = round(s.x1, prec); s.y1 = round(s.y1, prec);
      } else if (s.t === 'A') {
        s.rx = round(s.rx, prec); s.ry = round(s.ry, prec); s.rot = round(s.rot, prec);
      }
    }

    // Segments that go nowhere, dropped before anything tries to reason about
    // the direction they point in.
    let cur = { x: sub.x, y: sub.y };
    const segs = [];
    for (const s of sub.segs) {
      const end = { x: s.x, y: s.y };
      if (same(cur, end, eps)) {
        if (s.t === 'L') continue;
        const c1 = { x: s.x1, y: s.y1 };
        const c2 = s.t === 'C' ? { x: s.x2, y: s.y2 } : c1;
        if (s.t !== 'A' && same(c1, cur, eps) && same(c2, cur, eps)) continue;
      }
      segs.push(s);
      cur = end;
    }

    // Runs of curves, collapsed into as few curves as still draw the same
    // shape. This is where a hand drawn stroke gives up most of its vertices:
    // the editor writes one cubic per mouse sample and the run of them is
    // usually one gentle arc.
    //
    // This has to happen before the flattening below and not after. At any
    // useful tolerance each individual cubic in a dense run is flat enough to
    // pass for a line on its own, so flattening first turns the whole run into
    // a polygon and leaves the fitter nothing to work on. That polygon meets
    // the tolerance, but it is both more vertices than the curves it replaced
    // and visibly faceted the moment the sprite is scaled up, which is the
    // opposite of the point.
    const merged = [];
    let p = { x: sub.x, y: sub.y };
    let i = 0;
    while (i < segs.length) {
      if (segs[i].t !== 'C') { merged.push(segs[i]); p = { x: segs[i].x, y: segs[i].y }; i++; continue; }
      let j = i;
      while (j < segs.length && segs[j].t === 'C') j++;
      const run = segs.slice(i, j);

      let at = 0;
      let from = p;
      while (at < run.length) {
        // Longest first, halving on failure. A run that fits whole costs one
        // try, and one that does not still settles in a few.
        let take = run.length - at;
        let best = null;
        while (take > 1) {
          const chunk = run.slice(at, at + take);
          const pts = sampleChain(from, chunk, 96);
          const last = chunk[chunk.length - 1];
          const t1 = unit(chunk[0].x1 - from.x, chunk[0].y1 - from.y) ||
                     unit(pts[1].x - from.x, pts[1].y - from.y);
          const t2 = unit(last.x2 - last.x, last.y2 - last.y) ||
                     unit(pts[pts.length - 2].x - last.x, pts[pts.length - 2].y - last.y);
          if (t1 && t2) {
            const fit = fitCubic(pts, t1, t2);
            if (fit && fit.err <= move) {
              best = { take: take, seg: { t: 'C',
                x1: round(fit.c1.x, prec), y1: round(fit.c1.y, prec),
                x2: round(fit.c2.x, prec), y2: round(fit.c2.y, prec),
                x: last.x, y: last.y } };
              break;
            }
          }
          take = take > 2 ? Math.floor(take / 2) : take - 1;
        }
        if (best) {
          merged.push(best.seg);
          from = { x: best.seg.x, y: best.seg.y };
          at += best.take;
        } else {
          merged.push(run[at]);
          from = { x: run[at].x, y: run[at].y };
          at++;
        }
      }
      p = from;
      i = j;
    }

    // Curves that are within the tolerance of their own chord, written as the
    // line they already are. A cubic never strays further from its chord than
    // the furthest of its two control points, so a control point on the chord
    // is a curve on the chord. What reaches here is either a fitted curve that
    // turned out straight or a lone curve no run would take, so nothing smooth
    // is lost to this.
    const flat = [];
    cur = { x: sub.x, y: sub.y };
    for (const s of merged) {
      const end = { x: s.x, y: s.y };
      if (s.t === 'C' || s.t === 'Q') {
        const c1 = { x: s.x1, y: s.y1 };
        const c2 = s.t === 'C' ? { x: s.x2, y: s.y2 } : c1;
        if (distToSeg(c1, cur, end) <= move && distToSeg(c2, cur, end) <= move) {
          if (!same(cur, end, eps)) flat.push({ t: 'L', x: s.x, y: s.y });
          cur = end;
          continue;
        }
      }
      flat.push(s);
      cur = end;
    }

    // Runs of straight segments, thinned by Douglas-Peucker. The ends of a run
    // are always kept, so a run never drags a curve join with it.
    const out = [];
    i = 0;
    let start = { x: sub.x, y: sub.y };
    while (i < flat.length) {
      if (flat[i].t !== 'L') { out.push(flat[i]); start = { x: flat[i].x, y: flat[i].y }; i++; continue; }
      let j = i;
      const pts = [start];
      while (j < flat.length && flat[j].t === 'L') { pts.push({ x: flat[j].x, y: flat[j].y }); j++; }
      const kept = rdp(pts, move);
      for (let k = 1; k < kept.length; k++) out.push({ t: 'L', x: kept[k].x, y: kept[k].y });
      start = pts[pts.length - 1];
      i = j;
    }

    // A closing z already draws the line back to the start, so an explicit one
    // in front of it is a free vertex.
    if (sub.closed && out.length) {
      const last = out[out.length - 1];
      if (last.t === 'L' && same(last, { x: sub.x, y: sub.y }, eps)) out.pop();
    }

    sub.segs = out;
    return sub;
  }

  function countSegs(subs) {
    let n = 0;
    for (const s of subs) n += s.segs.length + 1;
    return n;
  }

  /* ---------------------------------------------------- document cleanup */

  const JUNK = { metadata: 1, title: 1, desc: 1 };
  const EDITOR_NS = /^(sodipodi|inkscape|adobe|illustrator|graph|i|x|dc|cc|rdf)[:_]/i;

  function stripJunk(root, stats) {
    const dead = [];
    (function walk(el) {
      for (let i = 0; i < el.childNodes.length; i++) {
        const c = el.childNodes[i];
        if (c.nodeType === 8) { dead.push(c); continue; }          // comment
        if (c.nodeType === 7) { dead.push(c); continue; }          // processing instruction
        if (c.nodeType === 1) {
          if (JUNK[c.localName]) { dead.push(c); continue; }
          walk(c);
        }
      }
    })(root);
    for (const c of dead) { if (c.parentNode) c.parentNode.removeChild(c); stats.junk++; }

    // Editor bookkeeping. Namespaced attributes an svg renderer has never read
    // and never will, and they are often the longest strings in the file.
    const all = root.getElementsByTagName('*');
    const list = [root];
    for (let i = 0; i < all.length; i++) list.push(all[i]);
    for (const el of list) {
      const attrs = el.attributes;
      for (let i = attrs.length - 1; i >= 0; i--) {
        const a = attrs[i];
        if (EDITOR_NS.test(a.name) || /^xmlns:(sodipodi|inkscape|dc|cc|rdf|i|x|graph)$/i.test(a.name)) {
          el.removeAttribute(a.name);
          stats.attrs++;
        }
      }
    }
  }

  // An id nothing points at is dead weight, but working out what points at what
  // is only safe while the answer is a fixed set of attributes. A stylesheet
  // can select on anything, so the presence of one calls the whole thing off.
  function stripIds(root, stats) {
    if (root.querySelector('style')) return;
    const used = new Set();
    const all = root.getElementsByTagName('*');
    const list = [root];
    for (let i = 0; i < all.length; i++) list.push(all[i]);

    for (const el of list) {
      const attrs = el.attributes;
      for (let i = 0; i < attrs.length; i++) {
        const v = attrs[i].value;
        let m;
        const re = /url\(\s*['"]?#([^)'"\s]+)/g;
        while ((m = re.exec(v))) used.add(m[1]);
        if ((attrs[i].localName === 'href') && v[0] === '#') used.add(v.slice(1));
      }
    }
    for (const el of list) {
      const id = el.getAttribute('id');
      if (id && !used.has(id)) { el.removeAttribute('id'); stats.attrs++; }
      if (el.hasAttribute('class')) { el.removeAttribute('class'); stats.attrs++; }
    }
  }

  const ROUNDABLE = ['x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry',
                     'x1', 'y1', 'x2', 'y2', 'stroke-width', 'stroke-miterlimit',
                     'offset', 'font-size'];

  function roundAttrs(root, prec, stats) {
    const all = root.getElementsByTagName('*');
    // An embedded bitmap is resampled by wherever its corners land, so a
    // hundredth of a unit of rounding on it, or on any transform above it,
    // rewrites every pixel it draws rather than nudging an outline. That is a
    // change the final check is right to refuse, and it was refusing whole
    // costumes over a couple of saved bytes. Anything holding a raster keeps
    // its geometry exactly.
    const raster = !!root.querySelector('image');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (raster && el.localName === 'image') continue;
      for (const name of ROUNDABLE) {
        const v = el.getAttribute(name);
        if (v === null || /[a-z%]/i.test(v)) continue;
        const num = parseFloat(v);
        if (!isFinite(num)) continue;
        const s = fmt(round(num, prec));
        if (s !== v) { el.setAttribute(name, s); stats.attrs++; }
      }
      // transform lists carry the same float tails as the path data does
      const tr = raster ? null : el.getAttribute('transform');
      if (tr) {
        const s = tr.replace(NUM, m => fmt(round(parseFloat(m), Math.max(prec, 4))));
        if (s !== tr) { el.setAttribute('transform', s); stats.attrs++; }
      }
      // points on a polyline or polygon are vertices like any other
      const pointsAttr = el.getAttribute('points');
      if (pointsAttr !== null && (el.localName === 'polyline' || el.localName === 'polygon')) {
        const nums = pointsAttr.match(NUM);
        if (nums && nums.length >= 4) {
          let pts = [];
          for (let k = 0; k + 1 < nums.length; k += 2) {
            pts.push({ x: round(parseFloat(nums[k]), prec), y: round(parseFloat(nums[k + 1]), prec) });
          }
          const before = pts.length;
          if (stats.tol > 0) pts = rdp(pts, stats.tol);
          stats.points += before - pts.length;
          const s = pts.map(p => fmt(p.x) + ',' + fmt(p.y)).join(' ');
          if (s !== pointsAttr) { el.setAttribute('points', s); stats.attrs++; }
        }
      }
    }
  }

  function simplifyPaths(root, tol, prec, stats) {
    const paths = root.getElementsByTagName('path');
    for (let i = 0; i < paths.length; i++) {
      const el = paths[i];
      const d = el.getAttribute('d');
      const cmds = parsePath(d);
      if (!cmds) { stats.unreadable++; continue; }
      const subs = normalize(cmds);
      const before = countSegs(subs);
      for (const sub of subs) simplifySub(sub, tol, prec);
      const after = countSegs(subs);
      const out = emit(subs);
      if (!out) continue;
      stats.verts += before;
      stats.vertsAfter += after;
      // A path already written tighter than this can write it keeps what it had
      if (out.length < d.length) el.setAttribute('d', out);
      else stats.vertsAfter += 0;
    }
  }

  /* ------------------------------------------------------------ drawing */

  // A costume box is the bounding box of the drawing, so the drawing touches
  // it on all four sides by definition, and rendering exactly that box puts an
  // outline hard against the canvas border at the top, bottom and both extremes.
  // An outline there has nothing on the far side of it to be compared with, so
  // it does not look like an outline to the edge check below, and a legitimate
  // shift of it gets read as a costume being altered somewhere flat. A few
  // pixels of air on every side is the whole fix.
  const MARGIN = 4;

  function frame(box) {
    let scale = VERIFY_SCALE;
    const room = MAX_SIDE - 2 * MARGIN;
    const k = Math.min(1, room / (box.w * scale), room / (box.h * scale));
    if (k < 1) scale *= k;
    const w = Math.max(1, Math.round(box.w * scale));
    const h = Math.max(1, Math.round(box.h * scale));
    const pad = MARGIN / scale;
    return {
      w: w + 2 * MARGIN,
      h: h + 2 * MARGIN,
      scale: scale,
      box: { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad }
    };
  }

  const RENDER_ATTRS = ['width', 'height', 'viewBox', 'preserveAspectRatio'];

  async function draw(root, f) {
    // Borrow the root and give it back rather than cloning it. Culling draws
    // the same tree many times over, and a deep clone of every node in the file
    // before each draw is a cost that grows with the square of how detailed the
    // costume is, which is exactly the costume that needed the help.
    const keep = RENDER_ATTRS.map(k => root.getAttribute(k));
    let text;
    try {
      root.setAttribute('width', f.w);
      root.setAttribute('height', f.h);
      root.setAttribute('viewBox', f.box.x + ' ' + f.box.y + ' ' + f.box.w + ' ' + f.box.h);
      // "none" rather than a meet: the box and the canvas are the same shape
      // anyway, and this leaves no room for a rounding difference to shift the
      // drawing by a pixel between one render and the next.
      root.setAttribute('preserveAspectRatio', 'none');
      text = '<?xml version="1.0" encoding="UTF-8"?>' +
        new XMLSerializer().serializeToString(root);
    } finally {
      RENDER_ATTRS.forEach((k, i) => {
        if (keep[i] === null) root.removeAttribute(k);
        else root.setAttribute(k, keep[i]);
      });
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    const img = new Image();
    try {
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error('the browser could not draw it'));
        img.src = url;
      });
      if (img.decode) { try { await img.decode(); } catch (e) { /* onload was enough */ } }
    } finally {
      URL.revokeObjectURL(url);
    }
    const canvas = document.createElement('canvas');
    canvas.width = f.w;
    canvas.height = f.h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, f.w, f.h);
    return ctx.getImageData(0, 0, f.w, f.h).data;
  }

  // Colour is compared premultiplied. Two fully transparent pixels are the same
  // pixel whatever rgb the canvas left underneath them, and comparing the raw
  // channels would call that a difference and refuse edits that changed nothing.
  // Four channels at a time. Two pixels that are the same word are the same
  // pixel and cannot be outside any tolerance, so the arithmetic below only has
  // to run where the words already disagree, which on the comparison this is
  // asked for most - a costume that came back identical - is nowhere at all.
  const words = px => new Uint32Array(px.buffer, px.byteOffset, px.length >> 2);

  function apartAt(a, b, p, tol) {
    const aa = a[p + 3], ba = b[p + 3];
    return Math.abs(aa - ba) > tol ||
           Math.abs(a[p] * aa - b[p] * ba) > tol * 255 ||
           Math.abs(a[p + 1] * aa - b[p + 1] * ba) > tol * 255 ||
           Math.abs(a[p + 2] * aa - b[p + 2] * ba) > tol * 255;
  }

  // A pixel that had any alpha and now has none is a difference whatever the
  // tolerance says. The tolerance is for colour a renderer may waver on
  // between two draws, not for pixels leaving the costume, and a pixel is
  // exactly what a Scratch collision check asks about, however faint it is.
  function differs(a, b, tol) {
    const wa = words(a), wb = words(b), n = wa.length;
    for (let i = 0; i < n; i++) {
      if (wa[i] === wb[i]) continue;
      const p = i << 2;
      if (a[p + 3] !== 0 && b[p + 3] === 0) return true;
      if (apartAt(a, b, p, tol)) return true;
    }
    return false;
  }

  // Simplifying is allowed to move an edge. That is the whole deal, and the
  // tolerance is how far. So the question the check asks is not "did any pixel
  // change", which for an antialiased outline is yes to a half pixel shift and
  // yes to a costume being destroyed alike. It is "did anything change that was
  // not an edge entitled to move". Pixels the original drew as part of an
  // outline get a band around them as wide as the tolerance; everywhere else,
  // interiors and flat colour and empty space, has to come back exactly.
  // What counts as an outline: a jump between neighbouring pixels bigger than a
  // fill can make on its own. A gradient walks across its shape a level or two
  // at a time; an outline lands in one or two pixels and is worth tens.
  const EDGE_STEP = 12;

  // An outline is a big local jump, and nothing else is.
  //
  // Two much simpler rules were wrong in the same way, and both were wrong
  // silently. Calling every partly transparent pixel an outline marks the whole
  // interior of any shape painted at less than full opacity, and calling any
  // variation at all an outline marks the whole interior of any gradient. Either
  // one hands back a band that covers the shape end to end, and a band that
  // covers everything forgives everything: the check would still have run, still
  // have passed, and still have meant nothing, on exactly the artwork most
  // likely to need it.
  function edgeMask(ref, w, h) {
    const n = w * h;
    const wd = words(ref);
    const mask = new Uint8Array(n);
    const varies = (p, q) => {
      const aa = ref[p + 3], ba = ref[q + 3];
      // premultiplied, so a colour nobody can see is not a difference
      return Math.abs(aa - ba) > EDGE_STEP ||
             Math.abs(ref[p] * aa - ref[q] * ba) > EDGE_STEP * 255 ||
             Math.abs(ref[p + 1] * aa - ref[q + 1] * ba) > EDGE_STEP * 255 ||
             Math.abs(ref[p + 2] * aa - ref[q + 2] * ba) > EDGE_STEP * 255;
    };
    // same word, same pixel: the flat insides of a shape settle in one compare
    const diff = (i, j) => wd[i] !== wd[j] && varies(i << 2, j << 2);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (x + 1 < w && diff(i, i + 1)) { mask[i] = 1; continue; }
        if (y + 1 < h && diff(i, i + w)) { mask[i] = 1; continue; }
        if (x > 0 && diff(i, i - 1)) { mask[i] = 1; continue; }
        if (y > 0 && diff(i, i - w)) mask[i] = 1;
      }
    }
    return mask;
  }

  // Two sweeps per axis, carrying how far back the last set pixel was, instead
  // of re-reading the whole window at every pixel. Same result, and it stops
  // costing more as the band gets wider.
  function dilate(mask, w, h, r) {
    if (r <= 0) return mask;
    const n = w * h;
    const tmp = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let last = -1e9;
      for (let x = 0; x < w; x++) {
        if (mask[row + x]) last = x;
        if (x - last <= r) tmp[row + x] = 1;
      }
      last = 1e9;
      for (let x = w - 1; x >= 0; x--) {
        if (mask[row + x]) last = x;
        if (last - x <= r) tmp[row + x] = 1;
      }
    }
    const out = new Uint8Array(n);
    for (let x = 0; x < w; x++) {
      let last = -1e9;
      for (let y = 0; y < h; y++) {
        if (tmp[y * w + x]) last = y;
        if (y - last <= r) out[y * w + x] = 1;
      }
      last = 1e9;
      for (let y = h - 1; y >= 0; y--) {
        if (tmp[y * w + x]) last = y;
        if (last - y <= r) out[y * w + x] = 1;
      }
    }
    return out;
  }

  function differsBeyondEdges(ref, img, w, h, radius, tol) {
    // Nothing changed anywhere is the common answer and does not need the mask
    // built to know it.
    const wa = words(ref), wb = words(img), n = wa.length;
    let first = -1;
    for (let i = 0; i < n; i++) {
      if (wa[i] !== wb[i]) { first = i; break; }
    }
    if (first < 0) return false;

    const band = dilate(edgeMask(ref, w, h), w, h, radius);
    for (let i = first; i < n; i++) {
      if (band[i] || wa[i] === wb[i]) continue;
      if (apartAt(ref, img, i << 2, tol)) return true;
    }
    return false;
  }

  /* -------------------------------------------------------------- culling */

  const PAINTED = { path: 1, rect: 1, circle: 1, ellipse: 1, line: 1, polyline: 1,
                    polygon: 1, text: 1, image: 1, use: 1, g: 1 };

  // Anything whose effect reaches outside its own shape makes "remove it and
  // look" the wrong question, because what changed might be somewhere else
  // entirely. Text is out because these fonts are this machine's, not Scratch's,
  // and a glyph that draws nothing here may draw something there. An image
  // pointing anywhere but at its own bytes cannot load inside the render at all,
  // so it would look invisible and it is not.
  // Naming one of these properties is not the same as using it. Every costume
  // the Scratch paint editor saves carries style="mix-blend-mode: normal" on
  // its painting layer, which is paper.js boilerplate for the default, and a
  // check that only looked for the property name switched culling off for
  // essentially every costume in existence. Only a value that actually does
  // something counts.
  const INERT = { '': 1, normal: 1, none: 1, initial: 1, unset: 1, inherit: 1 };

  function active(v) {
    return !!v && !INERT[String(v).trim().toLowerCase()];
  }

  function styleActs(style) {
    const re = /(?:^|;)\s*(mix-blend-mode|filter|clip-path|mask)\s*:\s*([^;]*)/gi;
    let m;
    while ((m = re.exec(style))) if (active(m[2])) return true;
    return false;
  }

  function cullSafe(root) {
    if (root.querySelector('filter,mask,clipPath,pattern,marker,text,style,foreignObject')) {
      return 'has text, filters or masks';
    }
    const all = root.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (active(el.getAttribute('filter')) || active(el.getAttribute('mask')) ||
          active(el.getAttribute('clip-path'))) {
        return 'has text, filters or masks';
      }
      if (styleActs(el.getAttribute('style') || '')) return 'blends with what is under it';
      if (el.localName === 'image') {
        const href = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
        if (href.slice(0, 5) !== 'data:') return 'links to an image it does not contain';
      }
    }
    return null;
  }

  function referenced(root) {
    const used = new Set();
    const all = root.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      const attrs = all[i].attributes;
      for (let k = 0; k < attrs.length; k++) {
        const v = attrs[k].value;
        let m;
        const re = /url\(\s*['"]?#([^)'"\s]+)/g;
        while ((m = re.exec(v))) used.add(m[1]);
        if (attrs[k].localName === 'href' && v[0] === '#') used.add(v.slice(1));
      }
    }
    return used;
  }

  function boxMoved(a, b, eps) {
    return Math.abs(a.x - b.x) > eps || Math.abs(a.y - b.y) > eps ||
           Math.abs(a.w - b.w) > eps || Math.abs(a.h - b.h) > eps;
  }

  // getBBox answers in the element's own user space, which is not the root's if
  // anything between them carries a transform, and in a Scratch costume
  // something always does. Compose the transforms down the chain and put the
  // box back into the space the costume is measured in.
  function toRoot(el, root) {
    let m = root.createSVGMatrix();
    const chain = [];
    for (let n = el; n && n !== root; n = n.parentNode) chain.push(n);
    for (let i = chain.length - 1; i >= 0; i--) {
      const t = chain[i].transform && chain[i].transform.baseVal.consolidate();
      if (t) m = m.multiply(t.matrix);
    }
    return m;
  }

  function mapBox(bb, m) {
    const xs = [], ys = [];
    for (const c of [[bb.x, bb.y], [bb.x + bb.width, bb.y],
                     [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]]) {
      xs.push(m.a * c[0] + m.c * c[1] + m.e);
      ys.push(m.b * c[0] + m.d * c[1] + m.f);
    }
    const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    const y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // Which shapes are holding the costume box open. scratch-vm sizes a costume
  // by the union of what is drawn, grown by half the widest stroke in the file,
  // so a shape is load bearing if its own box reaches one of the four extremes,
  // or if it is the one carrying that widest stroke. Those are left alone
  // whatever they look like: removing one resizes and shifts the costume on the
  // stage, which is worse than leaving an invisible shape in the file.
  //
  // Working this out once, up front, is also what gives the search below each
  // shape's own bounds, which is how it gets to look at a corner of the costume
  // instead of all of it. Asking the document instead would mean a fresh layout
  // per candidate.
  function measureParts(root, candidates) {
    const host = RASTER.hostNode();
    host.appendChild(root);
    const info = [];
    try {
      for (const el of candidates) {
        let bb = null;
        try { bb = el.getBBox(); } catch (e) { bb = null; }
        info.push(bb ? { box: mapBox(bb, toRoot(el, root)),
                         stroke: RASTER.largestStrokeWidth(el) } : null);
      }
    } finally {
      host.removeChild(root);
    }

    let u = null, maxStroke = 0;
    for (const it of info) {
      if (!it) continue;
      maxStroke = Math.max(maxStroke, it.stroke);
      u = u ? {
        x: Math.min(u.x, it.box.x), y: Math.min(u.y, it.box.y),
        x1: Math.max(u.x1, it.box.x + it.box.w), y1: Math.max(u.y1, it.box.y + it.box.h)
      } : { x: it.box.x, y: it.box.y, x1: it.box.x + it.box.w, y1: it.box.y + it.box.h };
    }

    // Which extreme each shape reaches, and how many shapes reach it. What
    // actually pins a shape is being the only one holding an edge out, not
    // merely touching it: two copies of the same rectangle both touch all four,
    // and one of them can still go because the other goes on holding them.
    //
    // The stroke works the same way and needs the same care. When no shape in
    // the file is stroked the widest stroke is zero, every shape carries it,
    // and a rule of "carries the widest stroke" pins the entire costume - which
    // is what it did, and why nothing was ever culled out of flat artwork.
    const eps = 1e-6;
    const holds = info.map(it => {
      if (!it || !u) return null;
      return {
        x0: Math.abs(it.box.x - u.x) <= eps,
        y0: Math.abs(it.box.y - u.y) <= eps,
        x1: Math.abs(it.box.x + it.box.w - u.x1) <= eps,
        y1: Math.abs(it.box.y + it.box.h - u.y1) <= eps,
        stroke: maxStroke > 0 && it.stroke >= maxStroke - eps
      };
    });
    const count = { x0: 0, y0: 0, x1: 0, y1: 0, stroke: 0 };
    for (const h of holds) {
      if (!h) continue;
      for (const k of ['x0', 'y0', 'x1', 'y1', 'stroke']) if (h[k]) count[k]++;
    }
    return { info: info, holds: holds, count: count, maxStroke: maxStroke };
  }

  // The window of the costume a shape could possibly have painted in: its own
  // bounds, grown by the widest stroke in the file and a couple of pixels of
  // slack, snapped out to whole pixels of the full frame's grid. Removing a
  // shape cannot change anything outside this, because everything that could
  // have carried its effect somewhere else - filters, masks, blend modes - was
  // ruled out before any of this ran.
  // The window a shape could possibly have painted in: its own bounds, grown by
  // the widest stroke in the file and a little slack, in whole frame pixels.
  // Removing a shape cannot change anything outside this, because everything
  // that could have carried its effect elsewhere - filters, masks, blend modes -
  // was ruled out before any of this ran.
  //
  // Only the comparison is narrowed to this window. Rendering narrowed to it as
  // well would be faster still, and does not work: Chromium does not rasterize
  // an svg to the same pixels when the canvas around it changes size, even at
  // the same scale and on the same pixel grid, so a small render and a big one
  // disagree along every antialiased curve. Those disagreements are harmless in
  // themselves - they read as "this shape mattered", so shapes get kept rather
  // than lost - but they read that way for every shape, and nothing is ever
  // culled at all. Both pictures being compared have to come out of the same
  // size of canvas.
  function windowFor(f, bb, stroke) {
    const grow = stroke / 2 + 2 / f.scale;
    const x0 = Math.max(0, Math.floor((bb.x - grow - f.box.x) * f.scale));
    const y0 = Math.max(0, Math.floor((bb.y - grow - f.box.y) * f.scale));
    const x1 = Math.min(f.w, Math.ceil((bb.x + bb.w + grow - f.box.x) * f.scale));
    const y1 = Math.min(f.h, Math.ceil((bb.y + bb.h + grow - f.box.y) * f.scale));
    if (!(x1 > x0) || !(y1 > y0)) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // Two full frames, compared only inside a rectangle, with the same rule
  // differs has about alpha: ink leaving a pixel entirely is never within
  // tolerance.
  function differsInRect(a, b, w, r, tol) {
    for (let j = 0; j < r.h; j++) {
      let p = ((r.y + j) * w + r.x) << 2;
      for (let i = 0; i < r.w; i++, p += 4) {
        if (a[p] === b[p] && a[p + 1] === b[p + 1] &&
            a[p + 2] === b[p + 2] && a[p + 3] === b[p + 3]) continue;
        if (a[p + 3] !== 0 && b[p + 3] === 0) return true;
        if (apartAt(a, b, p, tol)) return true;
      }
    }
    return false;
  }

  // Whether anything at all was drawn inside a rectangle of the frame. Zero
  // exactly, no tolerance: the shapes this is asked about are the ones drawn
  // too faint to see, and one step of alpha is still a pixel.
  function paintsInRect(img, w, r) {
    for (let j = 0; j < r.h; j++) {
      let p = ((r.y + j) * w + r.x) << 2;
      for (let i = 0; i < r.w; i++, p += 4) {
        if (img[p + 3] !== 0) return true;
      }
    }
    return false;
  }

  // The invariant: what is left always draws the same pixels as the original.
  // Each candidate is tried against that original, not against the drawing as
  // it stands, and put back the moment it makes a difference. Two identical
  // shapes stacked on each other therefore lose exactly one of themselves: the
  // first goes because the second still covers it, and the second stays because
  // by then nothing else does.
  //
  // Unchanged pixels alone are not enough to go. A shape can also leave the
  // drawing unchanged by never having drawn anything, a rectangle at zero
  // opacity, and those stay. Games use exactly that shape as collision
  // geometry, and Scratch answers a collision by the costume's pixels as its
  // own renderer put them down, which is not this renderer at this resolution.
  // The one removal that is provably safe on both counts is a shape whose ink
  // is really there and still drawn by the shapes above it: hidden behind
  // others, not invisible in itself.
  async function cull(root, box, f, ref, tol, limit, say, label) {
    const keepIds = referenced(root);
    const all = root.getElementsByTagName('*');
    // Every shape that draws, whether or not it may be removed. The ones that
    // may not still hold the costume box open, so they have to be in the
    // measurement even though they are never candidates.
    const leaves = [];
    const canGo = [];
    let offered = 0;
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!PAINTED[el.localName]) continue;
      if (el.localName === 'g' && el.children.length) continue;   // let its children answer first
      if (el.closest('defs')) continue;                           // defs draw nothing
      const id = el.getAttribute('id');
      const free = !(id && keepIds.has(id)) && offered < limit;
      if (free) offered++;
      leaves.push(el);
      canGo.push(free);
    }
    const capped = leaves.length > offered;

    const parts = measureParts(root, leaves);
    const held = parts.count;

    let removed = 0;
    let draws = 0;
    const gone = [];

    const KEYS = ['x0', 'y0', 'x1', 'y1', 'stroke'];
    const jobs = [];
    for (let i = 0; i < leaves.length; i++) {
      if (!canGo[i]) continue;
      const h = parts.holds[i];
      const info = parts.info[i];
      if (!h || !info || !leaves[i].parentNode) continue;
      const win = windowFor(f, info.box, parts.maxStroke);
      if (win) jobs.push({ el: leaves[i], win: win, h: h });
    }

    const hits = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x ||
                             a.y + a.h <= b.y || b.y + b.h <= a.y);

    // Shapes that do not overlap each other are gathered into sets, and a set
    // is answered by a single drawing.
    //
    // A shape can only have painted inside its own bounds, so its absence can
    // only show there. Take out a whole set of shapes whose bounds are pairwise
    // apart, draw once, and each shape's own window still answers for that
    // shape alone: nothing else that went missing could have reached into it.
    // One drawing settles as many shapes as the costume has room to spread out.
    //
    // This is not the same as asking about a set and splitting it when it
    // fails, which was tried and is worse than asking one at a time: that only
    // pays when most of what is asked about can go, and here almost nothing
    // can, so nearly every set fails and the splitting walks down to every
    // shape anyway, having paid for the failed sets on the way. Here nothing is
    // ever re-asked, because the answers were never mixed together.
    const sets = [];
    for (const job of jobs) {
      let placed = false;
      for (const s of sets) {
        let clash = false;
        for (const o of s) if (hits(o.win, job.win)) { clash = true; break; }
        if (!clash) { s.push(job); placed = true; break; }
      }
      if (!placed) sets.push([job]);
    }

    // Shapes are hidden and unhidden, not detached and put back. Detaching
    // means remembering where each one came from, and "where" is a sibling that
    // may itself have been taken out and kept out by the time anyone asks,
    // which is an insertBefore against a node that is no longer there. Nothing
    // moves in the tree until the whole cull has been accepted, so there is no
    // position to lose. display:none is what removal looks like to both things
    // that matter here: the drawing, and getBBox.
    //
    // Important with a priority: a presentation attribute loses to an inline
    // style, so a shape carrying style="display:inline" would go on being drawn
    // while this code believed it was gone, and the render coming back unchanged
    // would be read as proof the shape was invisible.
    const stash = new Map();
    function hide(el) {
      stash.set(el, {
        value: el.style.getPropertyValue('display'),
        priority: el.style.getPropertyPriority('display'),
        styled: el.hasAttribute('style')
      });
      el.style.setProperty('display', 'none', 'important');
    }
    function show(el) {
      const s = stash.get(el);
      el.style.removeProperty('display');
      if (s) {
        if (s.value) el.style.setProperty('display', s.value, s.priority);
        if (!s.styled && !el.getAttribute('style')) el.removeAttribute('style');
        stash.delete(el);
      }
    }

    for (const set of sets) {
      // A shape that has become the last one holding an edge of the costume out
      // stays, whatever it looks like: taking it out would resize and move the
      // costume on the stage.
      const spots = [];
      for (const job of set) {
        if (stash.has(job.el) || !job.el.parentNode) continue;
        if (KEYS.some(k => job.h[k] && held[k] <= 1)) continue;
        spots.push(job);
      }
      if (!spots.length) continue;

      await say('Checking ' + label + ' for hidden shapes');
      for (const job of spots) hide(job.el);

      let img = null;
      try {
        draws++;
        img = await draw(root, f);
      } catch (e) {
        img = null;
      }

      // First question: does the drawing miss it? A shape it does is shown
      // again now and stays.
      const covered = [];
      for (const job of spots) {
        if (img && !differsInRect(ref, img, f.w, job.win, tol)) covered.push(job);
        else show(job.el);
      }
      if (!covered.length) continue;

      // Second question: was there anything to miss? Each survivor is drawn by
      // itself, every other shape hidden, and one that put down no ink at all
      // stays: the drawing not missing it proved nothing, because there was
      // nothing to go missing. It is not hidden behind anything, it is
      // invisible in its own right, and that is the shape a game is most
      // likely to be colliding with. The windows in a set are pairwise apart,
      // so one drawing answers for every survivor in it.
      for (const job of covered) show(job.el);
      const solo = new Set(covered.map(j => j.el));
      const veil = [];
      for (const el of leaves) {
        if (!solo.has(el) && !stash.has(el) && el.parentNode) veil.push(el);
      }
      for (const el of veil) hide(el);
      let iso = null;
      try {
        draws++;
        iso = await draw(root, f);
      } catch (e) {
        iso = null;
      }
      for (const el of veil) show(el);

      // Decided in document order, because the box accounting is sequential:
      // two shapes sharing an edge can each go only while the other still holds
      // it, so whichever is judged first spends that shared hold.
      for (const job of covered) {
        if (iso && paintsInRect(iso, f.w, job.win) &&
            !KEYS.some(k => job.h[k] && held[k] <= 1)) {
          hide(job.el);
          removed++;
          gone.push(job.el);
          for (const k of KEYS) if (job.h[k]) held[k]--;
        }
      }
    }

    // Each shape was judged over its own window and the box was argued about
    // rather than measured, so both claims get asked of the document once, at
    // the end, over the whole costume: is it still the same size, and is it
    // still the same picture. Pixel for pixel this time, with none of the
    // latitude the vertex work is allowed. If either answer is no the entire
    // cull is handed back, because a costume that changed is not worth any
    // number of deleted shapes.
    if (gone.length) {
      let bad = false;
      let after = null;
      try { after = RASTER.measure(root); } catch (e) { after = null; }
      if (!after || boxMoved(box, after, 0.001)) bad = true;
      if (!bad) {
        try {
          draws++;
          bad = differs(ref, await draw(root, f), tol);
        } catch (e) {
          bad = true;
        }
      }
      if (bad) {
        for (const el of gone) show(el);
        return { removed: 0, draws: draws, capped: 0, bailed: true };
      }
      // accepted, so now they can actually go
      for (const el of gone) if (el.parentNode) el.parentNode.removeChild(el);
    }

    // groups that lost every child they had
    const groups = root.getElementsByTagName('g');
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i];
      if (!g.children.length && !g.textContent.trim() && g.parentNode) {
        g.parentNode.removeChild(g);
        removed++;
      }
    }
    return { removed: removed, draws: draws, capped: capped ? leaves.length - offered : 0 };
  }

  /* ---------------------------------------------------------------- pass */

  const fileOf = a => a.md5ext || (a.assetId + '.' + a.dataFormat);

  function serialize(root) {
    return new TextEncoder().encode(new XMLSerializer().serializeToString(root));
  }

  // One svg, start to finish. Returns the bytes to write, or a reason it was
  // left alone. Nothing here trusts itself: every version it builds is drawn
  // and compared before it is allowed to be the answer, and if none of them
  // survive that the original goes through untouched.
  async function optimizeOne(bytes, cfg, say, label) {
    const text = new TextDecoder().decode(bytes);
    const ref = RASTER.parseSvg(text);
    if (!ref) return { skip: 'not readable as svg' };

    let box;
    try {
      box = RASTER.measure(ref);
    } catch (e) {
      return { skip: 'could not be measured' };
    }
    if (!(box.w > 0) || !(box.h > 0)) return { skip: 'draws nothing' };

    // How heavy is it? With culling off this is the whole decision: a costume
    // that is not the problem does not get rewritten just because it could be.
    let verts = 0;
    const paths = ref.getElementsByTagName('path');
    for (let i = 0; i < paths.length; i++) {
      const cmds = parsePath(paths[i].getAttribute('d'));
      if (cmds) verts += countSegs(normalize(cmds));
    }
    const pl = ref.querySelectorAll('polyline,polygon');
    for (let i = 0; i < pl.length; i++) {
      const m = (pl[i].getAttribute('points') || '').match(NUM);
      if (m) verts += m.length >> 1;
    }
    if (!cfg.cull && verts < cfg.minVerts) {
      return { skip: null, light: true, verts: verts };
    }

    const f = frame(box);
    let refImg;
    try {
      refImg = await draw(ref, f);
    } catch (e) {
      return { skip: 'could not be drawn for checking' };
    }

    const why = cfg.cull ? cullSafe(ref) : null;
    const stats = { junk: 0, attrs: 0, points: 0, verts: 0, vertsAfter: 0,
                    unreadable: 0, tol: cfg.tolerance, culled: 0, capped: 0 };

    // Ask for everything, and on a costume that will not take it, ask for less
    // rather than walk away. Backing off the strength keeps the culling, which
    // is checked exactly and is almost never what the last check objects to,
    // and gives up only the vertex moving, which is. A costume that cannot be
    // simplified at the setting asked for is nearly always fine at a gentler
    // one, and giving it nothing because the first try was too ambitious threw
    // away a fifth of the costumes at the loose end of the slider.
    const canCull = cfg.cull && !why;
    const ladder = [];
    for (const t of (cfg.tolerance > 0 ? [cfg.tolerance, cfg.tolerance / 3, 0] : [0])) {
      ladder.push({ cull: canCull, tol: t });
    }
    if (canCull) ladder.push({ cull: false, tol: 0 });

    for (const attempt of ladder) {
      const tol = attempt.tol;
      const work = RASTER.parseSvg(text);
      const local = Object.assign({}, stats, { culled: 0, capped: 0, junk: 0, attrs: 0,
                                               points: 0, verts: 0, vertsAfter: 0,
                                               unreadable: 0, tol: tol, eased: tol < cfg.tolerance });
      if (attempt.cull) {
        // Deliberately not mounted here. RASTER.measure puts the node in the
        // host and takes it back out again on its own, so holding it there
        // across the loop only means the first measure detaches it and
        // everything after that is unmounting a node that already left.
        const r = await cull(work, box, f, refImg, cfg.visualTolerance, cfg.maxCull, say, label);
        local.culled = r.removed;
        local.capped = r.capped;
        local.draws = r.draws || 0;
      }
      stripJunk(work, local);
      stripIds(work, local);
      roundAttrs(work, cfg.precision, local);
      simplifyPaths(work, tol, cfg.precision, local);

      let after;
      try {
        after = RASTER.measure(work);
      } catch (e) {
        continue;
      }
      // Rounding can only move a coordinate by half a step and thinning can
      // only move one by the tolerance, so the box is allowed to breathe by
      // that much and not a hair more.
      const eps = Math.max(Math.pow(10, -cfg.precision), tol) + 1e-9;
      if (boxMoved(box, after, eps)) continue;

      let img;
      try {
        img = await draw(work, f);
      } catch (e) {
        continue;
      }
      // Culling above answers to differs() and has to be pixel for pixel: a
      // shape either contributed something or it did not, and there is no
      // tolerance to spend on that question. The vertex work answers to this
      // one, which knows what the tolerance bought.
      const radius = Math.ceil(tol * f.scale) + 2;
      if (differsBeyondEdges(refImg, img, f.w, f.h, radius, cfg.visualTolerance)) continue;

      const out = serialize(work);
      if (out.length >= bytes.length && !local.culled) {
        return { skip: null, light: true, verts: verts };
      }
      return { bytes: out, stats: local, verts: verts, why: why };
    }

    return { skip: 'the simplified version did not draw the same' };
  }

  // Returns the function sb3shrink calls once the json has been verified, with
  // the same shape as the rasterize and sound passes: it is handed the zip
  // entries and the project and may change both.
  function pass(cfg) {
    cfg = cfg || {};
    // Not `Number(x) || fallback`. Zero is a real answer to three of these -
    // lossless tolerance, whole number precision, a threshold that lets
    // everything through - and it is exactly the answer that idiom throws away.
    const num = (v, dflt) => {
      const n = Number(v);
      return (v === undefined || v === null || v === '' || !isFinite(n)) ? dflt : n;
    };
    const conf = {
      // Two decimals is a fiftieth of a stage pixel, which is below anything
      // that can be seen at any size Scratch draws a costume, and it is where
      // nearly all of the byte saving already comes from. It was a setting and
      // nobody could tell what it was for, so it is a constant.
      precision: Math.max(0, Math.min(5, Math.round(num(cfg.precision, 2)))),
      tolerance: Math.max(0, num(cfg.tolerance, 0.5)),
      cull: cfg.cull !== false,
      minVerts: Math.max(0, Math.round(num(cfg.minVerts, 400))),
      // A whole channel step. Below that is the renderer disagreeing with
      // itself between two draws of the same file, which it is entitled to do.
      visualTolerance: 1,
      maxCull: Math.max(1, Math.round(num(cfg.maxCull, 600)))
    };

    return async function simplify(entries, project, say) {
      const report = {
        precision: conf.precision, tolerance: conf.tolerance, cull: conf.cull,
        minVerts: conf.minVerts,
        total: 0, changed: 0, culled: 0, capped: 0, draws: 0, eased: 0,
        vertsBefore: 0, vertsAfter: 0,
        bytesBefore: 0, bytesAfter: 0,
        light: [], failed: [], noCull: []
      };

      const jobs = [];
      for (const t of project.targets) {
        for (const c of t.costumes) {
          if (c.dataFormat === 'svg') jobs.push({ target: t.name, costume: c });
        }
      }
      report.total = jobs.length;
      if (!jobs.length) return report;

      const byName = new Map();
      for (const e of entries) byName.set(e.name, e);
      const stamp = byName.get('project.json');
      const done = new Map();   // one pass per asset, however many costumes share it

      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const c = job.costume;
        const name = fileOf(c);
        await say('Simplifying ' + (i + 1) + ' of ' + jobs.length);

        let r = done.get(name);
        if (!r) {
          const entry = byName.get(name);
          if (!entry) {
            r = { skip: 'not in the archive' };
          } else {
            let raw = null;
            try {
              raw = await SB3.readEntry(entry);
            } catch (e) {
              r = { skip: 'could not be decompressed' };
            }
            if (raw) {
              try {
                r = await optimizeOne(raw, conf, say, (i + 1) + ' of ' + jobs.length);
              } catch (e) {
                r = { skip: e.message || 'could not be simplified' };
              }
              if (r.bytes) {
                r.md5 = RASTER.md5(r.bytes);
                r.was = entry.csize;
              }
            }
          }
          done.set(name, r);
        }

        if (r.skip) { report.failed.push({ target: job.target, name: c.name, why: r.skip }); continue; }
        if (r.light) { report.light.push({ target: job.target, name: c.name, why: r.verts + ' vertices' }); continue; }
        if (r.why && report.noCull.length < 200) {
          report.noCull.push({ target: job.target, name: c.name, why: r.why });
        }

        c.assetId = r.md5;
        c.dataFormat = 'svg';
        delete c.md5ext;

        if (!r.counted) {
          r.counted = true;
          report.changed++;
          report.culled += r.stats.culled;
          report.capped += r.stats.capped;
          report.draws += r.stats.draws || 0;
          if (r.stats.eased) report.eased++;
          report.vertsBefore += r.stats.verts;
          report.vertsAfter += r.stats.vertsAfter;
        }
      }

      // one entry per new asset, and never the same name twice: two costumes
      // can simplify to the same bytes, and a project can already hold them.
      for (const r of done.values()) {
        if (!r.bytes) continue;
        const name = r.md5 + '.svg';
        if (byName.has(name)) continue;
        const entry = await SB3.deflatedEntry(name, r.bytes, stamp);
        entries.push(entry);
        byName.set(name, entry);
        report.bytesAfter += entry.csize;
      }

      // drop the originals nothing points at any more. Only files this pass
      // touched are candidates, so the rest of the archive is left alone.
      const live = new Set();
      for (const t of project.targets) {
        for (const c of t.costumes) live.add(fileOf(c));
        for (const s of t.sounds) live.add(fileOf(s));
      }
      const dead = new Set();
      for (const name of done.keys()) if (!live.has(name)) dead.add(name);
      for (let i = entries.length - 1; i >= 0; i--) {
        if (dead.has(entries[i].name)) {
          report.bytesBefore += entries[i].csize;
          entries.splice(i, 1);
        }
      }

      return report;
    };
  }

  // The rest is exported so the checks can be checked. Nothing on the page
  // calls them.
  return { pass, parsePath, normalize, emit, simplifySub, rdp,
           differs, differsBeyondEdges, edgeMask, dilate, draw, frame,
           windowFor, differsInRect, paintsInRect };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SVGOPT;
