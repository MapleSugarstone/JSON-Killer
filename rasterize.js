/*
 * Rasterizes svg costumes to png. Optional, and unlike sb3shrink.js this one
 * needs the DOM: the browser reads the svg and the browser draws it, so the
 * result is only ever as good as the browser's own svg rasterizer. Svg text is
 * redrawn with whatever fonts this machine has, not Scratch's.
 *
 * Geometry follows transformMeasurements() in scratch-svg-renderer's
 * load-svg-string.js. A costume is the bounding box of what is actually drawn,
 * grown by half of the widest stroke width in the file, and that box, not the
 * viewBox the file declares, is what Scratch measures and positions against.
 * Matching it is what keeps a rasterized costume the same size and in the same
 * place on the stage.
 *
 * MIT licensed. See LICENSE.
 */
const RASTER = (function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const STAGE_W = 480;
  const STAGE_H = 360;

  /* ------------------------------------------------------------------ md5 */

  // Scratch names an asset by the md5 of its bytes, so a new png needs a new
  // md5. SubtleCrypto does not do md5, hence this. Constants are written out
  // rather than derived from Math.sin, whose last bit is implementation defined.
  const K = new Uint32Array([
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
    0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
    0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
    0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
    0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
    0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
  ]);

  const SHIFT = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];

  function leHex(w) {
    let s = '';
    for (let i = 0; i < 4; i++) s += ((w >>> (i * 8)) & 0xFF).toString(16).padStart(2, '0');
    return s;
  }

  function md5(bytes) {
    const len = bytes.length;
    const buf = new Uint8Array((((len + 8) >> 6) + 1) << 6);
    buf.set(bytes);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    // length in bits, low word first. len * 8 stays exact well past any file
    // a browser could hold, and >>> 0 takes it mod 2^32.
    dv.setUint32(buf.length - 8, (len * 8) >>> 0, true);
    dv.setUint32(buf.length - 4, Math.floor(len / 536870912), true);

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const m = new Uint32Array(16);

    for (let off = 0; off < buf.length; off += 64) {
      for (let i = 0; i < 16; i++) m[i] = dv.getUint32(off + i * 4, true);
      let a = a0, b = b0, c = c0, d = d0;
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
        else { f = c ^ (b | ~d); g = (7 * i) & 15; }
        const t = d;
        d = c;
        c = b;
        const s = SHIFT[i];
        const v = (a + f + K[i] + m[g]) >>> 0;
        b = (b + ((v << s) | (v >>> (32 - s)))) >>> 0;
        a = t;
      }
      a0 = (a0 + a) >>> 0;
      b0 = (b0 + b) >>> 0;
      c0 = (c0 + c) >>> 0;
      d0 = (d0 + d) >>> 0;
    }
    return leHex(a0) + leHex(b0) + leHex(c0) + leHex(d0);
  }

  /* -------------------------------------------------------------- measure */

  let host = null;

  // getBBox only answers for an element the document is laying out, so the svg
  // has to be in the page. Offscreen and invisible, but not display:none, which
  // is the one thing that would make getBBox useless.
  function hostNode() {
    if (!host) {
      host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText =
        'position:fixed;left:-20000px;top:0;width:1200px;height:1200px;' +
        'visibility:hidden;pointer-events:none;overflow:hidden';
      document.body.appendChild(host);
    }
    return host;
  }

  // findLargestStrokeWidth() from scratch-svg-renderer, kept faithful down to
  // the quirks: any stroke attribute at all counts as width 1, even "none", and
  // the root svg tag is walked along with its children.
  function largestStrokeWidth(node) {
    let largest = 0;
    (function walk(el) {
      if (el.getAttribute) {
        if (el.getAttribute('stroke')) largest = Math.max(largest, 1);
        if (el.getAttribute('stroke-width')) {
          largest = Math.max(largest, Number(el.getAttribute('stroke-width')) || 0);
        }
      }
      for (let i = 0; i < el.childNodes.length; i++) walk(el.childNodes[i]);
    })(node);
    return largest;
  }

  function measure(root) {
    const h = hostNode();
    h.appendChild(root);
    let bbox;
    try {
      bbox = root.getBBox();
    } finally {
      h.removeChild(root);
    }
    const half = (bbox.width === 0 || bbox.height === 0) ? 0 : largestStrokeWidth(root) / 2;
    return {
      x: bbox.x - half,
      y: bbox.y - half,
      w: bbox.width + half * 2,
      h: bbox.height + half * 2
    };
  }

  function parseSvg(text) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.getElementsByTagName('parsererror').length) return null;
    const root = doc.documentElement;
    if (!root || root.namespaceURI !== SVG_NS || root.localName !== 'svg') return null;
    return root;
  }

  /* ------------------------------------------------------------- drawing */

  async function toPng(root, box, scale, smooth, sample) {
    // Whole pixels only, rounded up, so nothing is ever cropped. The viewBox is
    // widened to match rather than the image squashed to fit, which leaves at
    // most a pixel of transparent margin on two sides.
    const pw = Math.max(1, Math.ceil(box.w * scale));
    const ph = Math.max(1, Math.ceil(box.h * scale));

    // Supersampling draws the same region larger and averages it back down, so
    // the costume keeps its pixel count and gains only edge accuracy. It is the
    // only headroom there is: see the note on scale in pass().
    const rw = pw * sample;
    const rh = ph * sample;

    root.setAttribute('width', rw);
    root.setAttribute('height', rh);
    root.setAttribute('viewBox', box.x + ' ' + box.y + ' ' + (pw / scale) + ' ' + (ph / scale));
    root.setAttribute('preserveAspectRatio', 'xMinYMin meet');

    if (!smooth) {
      // Hints only. An engine that honours them draws a hard edge from the
      // start, and one that does not costs nothing, so they are worth asking
      // for. What actually guarantees the result is the pixel pass after the
      // draw. They are inherited, so setting them on the root covers the file
      // unless something inside overrides them, which is what the sweep is for.
      const own = root.querySelectorAll('[shape-rendering],[text-rendering],[image-rendering]');
      for (let i = 0; i < own.length; i++) {
        own[i].removeAttribute('shape-rendering');
        own[i].removeAttribute('text-rendering');
        own[i].removeAttribute('image-rendering');
      }
      root.setAttribute('shape-rendering', 'crispEdges');
      root.setAttribute('text-rendering', 'optimizeSpeed');
      root.setAttribute('image-rendering', 'pixelated');
    }

    const text = '<?xml version="1.0" encoding="UTF-8"?>' + new XMLSerializer().serializeToString(root);
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
    canvas.width = pw;
    canvas.height = ph;
    const ctx = canvas.getContext('2d');

    if (sample > 1) {
      // The averaging has to happen between two canvases. Chromium rasterizes
      // an svg at the size it is drawn at rather than the size the file
      // declares, so drawing the <img> straight down to the target would
      // quietly rasterize at target size and supersample nothing: measured
      // pixel for pixel identical to not supersampling at all. Landing it at
      // full size first and resampling from pixels is what makes it real.
      const big = document.createElement('canvas');
      big.width = rw;
      big.height = rh;
      big.getContext('2d').drawImage(img, 0, 0, rw, rh);
      ctx.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(big, 0, 0, pw, ph);
    } else {
      // One to one, so there is nothing to resample either way.
      ctx.imageSmoothingEnabled = !!smooth;
      ctx.drawImage(img, 0, 0, pw, ph);
    }

    if (!smooth) {
      // The rendering hints above are advisory and Chromium ignores
      // shape-rendering:crispEdges outright for an svg drawn through an <img>,
      // so the edge is cut here instead, where it cannot be ignored.
      //
      // Not a flat threshold. A costume drawn half transparent on purpose is a
      // plateau of one alpha, and flattening that to opaque would be a worse
      // lie than the fringe. Each soft pixel is judged against the strongest
      // alpha it touches: half of that or more and it joins it, otherwise it
      // goes. A pixel in the middle of a plateau matches its own neighbours and
      // so keeps exactly what it had.
      const data = ctx.getImageData(0, 0, pw, ph);
      const px = data.data;
      const alpha = new Uint8Array(pw * ph);
      for (let i = 0, p = 3; i < alpha.length; i++, p += 4) alpha[i] = px[p];

      for (let y = 0; y < ph; y++) {
        for (let x = 0; x < pw; x++) {
          const a = alpha[y * pw + x];
          if (a === 0 || a === 255) continue;
          let peak = a;
          for (let dy = (y > 0 ? -1 : 0); dy <= (y < ph - 1 ? 1 : 0); dy++) {
            for (let dx = (x > 0 ? -1 : 0); dx <= (x < pw - 1 ? 1 : 0); dx++) {
              const v = alpha[(y + dy) * pw + (x + dx)];
              if (v > peak) peak = v;
            }
          }
          px[(y * pw + x) * 4 + 3] = (a * 2 >= peak) ? peak : 0;
        }
      }
      ctx.putImageData(data, 0, 0);
    }

    // toDataURL rather than toBlob. They encode the same bytes, but toBlob
    // hands the encode to the browser's task queue, which under any throttling
    // costs about a second per costume however small the canvas is. This is
    // synchronous and measured in single milliseconds.
    const uri = canvas.toDataURL('image/png');
    if (uri.slice(0, 15) !== 'data:image/png;') throw new Error('png encoding failed');
    const b64 = atob(uri.slice(uri.indexOf(',') + 1));
    const bytes = new Uint8Array(b64.length);
    for (let i = 0; i < b64.length; i++) bytes[i] = b64.charCodeAt(i);
    return { bytes: bytes, w: pw, h: ph };
  }

  /* --------------------------------------------------------------- costume */

  const fileOf = a => a.md5ext || (a.assetId + '.' + a.dataFormat);

  // Same rounding as sb3shrink's, so a rotation centre never gains a tail of
  // float noise on the way through.
  function round3(v) {
    if (typeof v !== 'number' || !isFinite(v)) return v;
    const scaled = v * 1000;
    if (Math.abs(scaled % 1) === 0.5) {
      const down = Math.floor(scaled);
      return (down % 2 === 0 ? down : down + 1) / 1000;
    }
    return Math.round(scaled) / 1000;
  }

  async function convert(entry, scale, smooth, sample) {
    if (!entry) return { error: 'not in the archive' };

    let raw;
    try {
      raw = await SB3.readEntry(entry);
    } catch (e) {
      return { error: 'could not be decompressed' };
    }

    const root = parseSvg(new TextDecoder().decode(raw));
    if (!root) return { error: 'not readable as svg' };

    let box;
    try {
      box = measure(root);
    } catch (e) {
      return { error: 'could not be measured' };
    }
    if (!(box.w > 0) || !(box.h > 0)) return { error: 'draws nothing' };
    if (box.w > STAGE_W || box.h > STAGE_H) return { tooBig: true, w: box.w, h: box.h };

    const hasText = !!root.querySelector('text');
    let png;
    try {
      png = await toPng(root, box, scale, smooth, sample);
    } catch (e) {
      return { error: e.message || 'could not be rasterized' };
    }
    return { png: png.bytes, md5: md5(png.bytes), box: box, hasText: hasText, w: png.w, h: png.h };
  }

  /* ------------------------------------------------------------------ pass */

  // Returns the function sb3shrink calls once the json has been verified. It is
  // handed the zip entries and the project and may change both.
  function pass(cfg) {
    cfg = cfg || {};

    // Capped at 2, and not arbitrarily. scratch-vm's load-costume.js assigns
    // costume.bitmapResolution = 2 on the way in, throwing away whatever the
    // file said, and BitmapSkin then sizes the costume as texture / 2. So a
    // costume is always shown at half its pixel size no matter what is written
    // here, and a 4x raster is not a sharper costume, it is one drawn twice as
    // big. 1x and 2x are the only resolutions that come out the right size, and
    // 1x only because the vm doubles it again at load. Extra detail at a fixed
    // size is not a thing Scratch can store, so sampling below buys quality
    // instead, at the same pixel count.
    const scale = Math.max(1, Math.min(2, Math.round(Number(cfg.scale) || 2)));
    const sample = Math.max(1, Math.min(4, Math.round(Number(cfg.supersample) || 1)));
    const smooth = cfg.antialias !== false;

    return async function rasterize(entries, project, say) {
      const report = {
        scale: scale, antialias: smooth, sample: sample,
        total: 0, converted: 0, assets: 0,
        tooBig: [], failed: [], text: [], bytesBefore: 0, bytesAfter: 0
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

      const done = new Map(); // one raster per asset, however many costumes share it

      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const c = job.costume;
        const name = fileOf(c);
        await say('Rasterizing ' + (i + 1) + ' of ' + jobs.length);

        let r = done.get(name);
        if (!r) {
          r = await convert(byName.get(name), scale, smooth, sample);
          r.was = byName.has(name) ? byName.get(name).csize : 0;
          done.set(name, r);
        }

        if (r.tooBig) {
          report.tooBig.push({ target: job.target, name: c.name, w: r.w, h: r.h });
          continue;
        }
        if (r.error) {
          report.failed.push({ target: job.target, name: c.name, why: r.error });
          continue;
        }

        // Rotation centres are in image pixels and scratch-vm divides them by
        // bitmapResolution, so they rescale with the raster. The box origin
        // comes off first because the png starts at the corner of the drawing,
        // wherever the svg's own coordinates happened to put it.
        const br = Number(c.bitmapResolution) || 1;
        if (typeof c.rotationCenterX === 'number') {
          c.rotationCenterX = round3((c.rotationCenterX / br - r.box.x) * scale);
        }
        if (typeof c.rotationCenterY === 'number') {
          c.rotationCenterY = round3((c.rotationCenterY / br - r.box.y) * scale);
        }
        c.assetId = r.md5;
        c.dataFormat = 'png';
        c.bitmapResolution = scale;
        // whatever it said before now names a file that is not there, and
        // scratch-vm rebuilds this one from assetId and dataFormat anyway
        delete c.md5ext;

        report.converted++;
        if (r.hasText) report.text.push({ target: job.target, name: c.name });
      }

      // one entry per new asset. Two different svgs can rasterize to the same
      // png, and a project can already contain the png we just made, so an
      // archive must never end up with the name twice.
      const stamp = byName.get('project.json');
      for (const r of done.values()) {
        if (!r.png) continue;
        const name = r.md5 + '.png';
        if (byName.has(name)) continue;
        const entry = SB3.storedEntry(name, r.png, stamp);
        entries.push(entry);
        byName.set(name, entry);
        report.assets++;
        report.bytesAfter += r.png.length;
      }

      // drop the svgs nothing points at any more. Only files this pass touched
      // are candidates, so anything else in the archive is left alone.
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

  return { pass, md5, STAGE_W, STAGE_H };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RASTER;
