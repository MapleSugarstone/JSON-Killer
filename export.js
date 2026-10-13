/*
 * Exports every costume and sound of an sb3 or sprite3 as a zip, one folder
 * per sprite, each file named as it is in the project. Needs the DOM.
 *
 * Scratch puts an uploaded costume's rotation center in the middle of what is
 * drawn. Padding each costume so its rotation center is in the middle is what
 * keeps a costume in the same place when it is uploaded again.
 *
 * MIT licensed. See LICENSE.
 */
const EXPORT = (function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // per side, past which a padded or rasterized costume is not drawn
  const MAX_PX = 8192;

  const fileOf = a => a.md5ext || (a.assetId + '.' + a.dataFormat);

  // Characters that Windows, macOS or Linux refuse in a file name.
  function safeName(s, fallback) {
    let t = String(s == null ? '' : s)
      .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
      .trim()
      .replace(/[. ]+$/, '');
    if (!t) t = fallback;
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(t)) t = '_' + t;
    return t.slice(0, 120);
  }

  // Adds " (2)", " (3)" and so on until the name is free, ignoring case.
  function claim(taken, base, ext) {
    let name = base + ext;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = base + ' (' + i + ')' + ext;
    taken.add(name.toLowerCase());
    return name;
  }

  // The smallest box holding `box` whose middle is (cx, cy).
  function centered(box, cx, cy) {
    const hw = Math.max(cx - box.x, box.x + box.w - cx);
    const hh = Math.max(cy - box.y, box.y + box.h - cy);
    return { x: cx - hw, y: cy - hh, w: hw * 2, h: hh * 2 };
  }

  function centerOf(c) {
    if (typeof c.rotationCenterX !== 'number' || typeof c.rotationCenterY !== 'number') return null;
    // A bitmap center is in image pixels. An svg center is divided the way
    // rasterize.js divides it.
    const br = c.dataFormat === 'svg' ? (Number(c.bitmapResolution) || 1) : 1;
    return { x: c.rotationCenterX / br, y: c.rotationCenterY / br };
  }

  function dataUriBytes(uri) {
    const b64 = atob(uri.slice(uri.indexOf(',') + 1));
    const bytes = new Uint8Array(b64.length);
    for (let i = 0; i < b64.length; i++) bytes[i] = b64.charCodeAt(i);
    return bytes;
  }

  /* ----------------------------------------------------------------- svg */

  async function svgCostume(bytes, c, cfg) {
    const root = RASTER.parseSvg(new TextDecoder().decode(bytes));
    if (!root) return { error: 'not readable as svg' };

    let box;
    try {
      box = RASTER.measure(root);
    } catch (e) {
      return { error: 'could not be measured' };
    }
    if (!(box.w > 0) || !(box.h > 0)) {
      return cfg.raster ? { error: 'draws nothing' } : { bytes: bytes, ext: 'svg' };
    }

    const ctr = cfg.pad ? centerOf(c) : null;
    const b = ctr ? centered(box, ctr.x, ctr.y) : box;

    if (cfg.raster) {
      const pw = Math.ceil(b.w * cfg.scale), ph = Math.ceil(b.h * cfg.scale);
      if (pw > MAX_PX || ph > MAX_PX) return { error: 'over ' + MAX_PX + ' px when drawn', w: pw, h: ph };
      const sample = Math.max(1, Math.min(cfg.sample, Math.floor(MAX_PX / Math.max(pw, ph))));
      try {
        const png = await RASTER.toPng(root, b, cfg.scale, cfg.antialias, sample);
        return { bytes: png.bytes, ext: 'png', padded: !!ctr, text: !!root.querySelector('text') };
      } catch (e) {
        return { error: e.message || 'could not be rasterized' };
      }
    }

    if (!ctr) return { bytes: bytes, ext: 'svg' };

    // Scratch measures what is drawn and ignores the viewBox, so an invisible
    // rectangle the size of the padded box is what makes the padding count.
    const rect = root.ownerDocument.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', b.x);
    rect.setAttribute('y', b.y);
    rect.setAttribute('width', b.w);
    rect.setAttribute('height', b.h);
    rect.setAttribute('fill', 'none');
    root.insertBefore(rect, root.firstChild);
    root.setAttribute('viewBox', b.x + ' ' + b.y + ' ' + b.w + ' ' + b.h);
    root.setAttribute('width', b.w);
    root.setAttribute('height', b.h);
    const text = '<?xml version="1.0" encoding="UTF-8"?>' + new XMLSerializer().serializeToString(root);
    return { bytes: new TextEncoder().encode(text), ext: 'svg', padded: true };
  }

  /* -------------------------------------------------------------- bitmap */

  async function bitmapCostume(bytes, c, cfg) {
    const ext = c.dataFormat;
    const ctr = cfg.pad ? centerOf(c) : null;
    if (!ctr) return { bytes: bytes, ext: ext };

    let img;
    try {
      img = await createImageBitmap(new Blob([bytes]));
    } catch (e) {
      return { bytes: bytes, ext: ext, why: 'could not be decoded, exported unpadded' };
    }
    const w = img.width, h = img.height;

    // Whole pixels, so the image is copied rather than resampled. The middle
    // lands at most half a pixel from the rotation center.
    const hw = Math.max(ctr.x, w - ctr.x), hh = Math.max(ctr.y, h - ctr.y);
    const left = Math.max(0, Math.round(hw - ctr.x));
    const top = Math.max(0, Math.round(hh - ctr.y));
    const pw = Math.max(left + w, Math.round(2 * (left + ctr.x)));
    const ph = Math.max(top + h, Math.round(2 * (top + ctr.y)));

    if (left === 0 && top === 0 && pw === w && ph === h) {
      img.close();
      return { bytes: bytes, ext: ext };
    }
    if (pw > MAX_PX || ph > MAX_PX) {
      img.close();
      return { bytes: bytes, ext: ext, why: 'over ' + MAX_PX + ' px when padded, exported unpadded' };
    }

    const canvas = document.createElement('canvas');
    canvas.width = pw;
    canvas.height = ph;
    canvas.getContext('2d').drawImage(img, left, top);
    img.close();
    // png even for a jpg, because the padding has to be transparent
    return { bytes: dataUriBytes(canvas.toDataURL('image/png')), ext: 'png', padded: true };
  }

  /* ---------------------------------------------------------------- run */

  async function run(buffer, cfg, say) {
    say = say || function () {};
    cfg = {
      pad: cfg.pad !== false,
      raster: !!cfg.raster,
      scale: Math.max(1, Math.min(4, Number(cfg.scale) || 1)),
      sample: Math.max(1, Math.min(4, Math.round(Number(cfg.supersample) || 1))),
      antialias: cfg.antialias !== false
    };

    say('Reading archive');
    const open = await SB3.openProject(buffer);
    const byName = new Map();
    for (const e of open.entries) byName.set(e.name, e);
    const stamp = open.entry;

    const report = {
      sprite: open.sprite, targets: 0, costumes: 0, sounds: 0,
      rasterized: 0, padded: 0, failed: [], notes: [], text: []
    };
    const out = [];
    const folders = new Set();
    const cache = new Map();

    const jobs = [];
    for (const t of open.project.targets) {
      for (const c of t.costumes) jobs.push({ t: t, a: c, sound: false });
      for (const s of t.sounds) jobs.push({ t: t, a: s, sound: true });
    }

    let folder = null, taken = null, current = null;
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i], a = job.a;
      if (job.t !== current) {
        current = job.t;
        folder = claim(folders, safeName(current.name, current.isStage ? 'Stage' : 'Sprite'), '');
        taken = new Set();
        report.targets++;
      }
      await say('Exporting ' + (i + 1) + ' of ' + jobs.length);

      const src = fileOf(a);
      const entry = byName.get(src);
      if (!entry) {
        report.failed.push({ target: current.name, name: a.name, why: 'not in the archive' });
        continue;
      }

      let r;
      if (job.sound) {
        r = { bytes: await SB3.readEntry(entry), ext: a.dataFormat };
      } else {
        const key = src + '|' + a.rotationCenterX + '|' + a.rotationCenterY;
        r = cache.get(key);
        if (!r) {
          const bytes = await SB3.readEntry(entry);
          r = a.dataFormat === 'svg' ? await svgCostume(bytes, a, cfg) : await bitmapCostume(bytes, a, cfg);
          cache.set(key, r);
        }
        if (r.error) {
          report.failed.push({ target: current.name, name: a.name, why: r.error });
          continue;
        }
        if (r.why) report.notes.push({ target: current.name, name: a.name, why: r.why });
        if (r.padded) report.padded++;
        if (r.ext === 'png' && a.dataFormat === 'svg') report.rasterized++;
        if (r.text) report.text.push({ target: current.name, name: a.name });
      }

      const name = folder + '/' + claim(taken, safeName(a.name, job.sound ? 'sound' : 'costume'), '.' + r.ext);
      out.push(r.ext === 'svg' || r.ext === 'wav'
        ? await SB3.deflatedEntry(name, r.bytes, stamp)
        : SB3.storedEntry(name, r.bytes, stamp));
      if (job.sound) report.sounds++;
      else report.costumes++;
    }

    say('Packing');
    const blob = new Blob([SB3.writeZip(out)], { type: 'application/zip' });
    return { blob: blob, report: report };
  }

  return { run, safeName, centered };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = EXPORT;
