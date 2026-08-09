/*
 * sb3shrink core. No DOM, no dependencies.
 *
 * Every transformation is semantics preserving and was checked against
 * scratch-vm (serialization/sb3.js, engine/blocks.js, thread.js, sequencer.js,
 * execute.js, import/load-costume.js) and against scratch-parser's upload
 * schema, which requires only "opcode" on a block and assetId/dataFormat/name
 * on a costume.
 *
 * MIT licensed. See LICENSE.
 */
const SB3 = (function () {
  'use strict';

  /* ------------------------------------------------------------------ zip */

  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  async function inflateRaw(bytes) {
    const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  async function deflateRaw(bytes) {
    const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  // Reads the central directory and returns entries holding their RAW,
  // still compressed bytes. Nothing but project.json is ever decompressed.
  function readZip(buffer) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);

    let eocd = -1;
    const floor = Math.max(0, u8.length - 22 - 0xFFFF);
    for (let i = u8.length - 22; i >= floor; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip archive. An sb3 file is a zip.');

    let count = dv.getUint16(eocd + 10, true);
    let cdOff = dv.getUint32(eocd + 16, true);

    if (count === 0xFFFF || cdOff === 0xFFFFFFFF) {
      const loc = eocd - 20;
      if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
        const z64 = Number(dv.getBigUint64(loc + 8, true));
        if (dv.getUint32(z64, true) !== 0x06064b50) throw new Error('Damaged zip64 record.');
        count = Number(dv.getBigUint64(z64 + 32, true));
        cdOff = Number(dv.getBigUint64(z64 + 48, true));
      }
    }

    const dec = new TextDecoder();
    const entries = [];
    let p = cdOff;

    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged central directory.');
      const flags = dv.getUint16(p + 8, true);
      const method = dv.getUint16(p + 10, true);
      const time = dv.getUint16(p + 12, true);
      const date = dv.getUint16(p + 14, true);
      const crc = dv.getUint32(p + 16, true);
      let csize = dv.getUint32(p + 20, true);
      let usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true);
      const elen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const extAttr = dv.getUint32(p + 38, true);
      let lho = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));

      if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || lho === 0xFFFFFFFF) {
        let q = p + 46 + nlen;
        const end = q + elen;
        while (q + 4 <= end) {
          const id = dv.getUint16(q, true);
          const sz = dv.getUint16(q + 2, true);
          if (id === 0x0001) {
            let r = q + 4;
            if (usize === 0xFFFFFFFF) { usize = Number(dv.getBigUint64(r, true)); r += 8; }
            if (csize === 0xFFFFFFFF) { csize = Number(dv.getBigUint64(r, true)); r += 8; }
            if (lho === 0xFFFFFFFF) { lho = Number(dv.getBigUint64(r, true)); r += 8; }
            break;
          }
          q += 4 + sz;
        }
      }

      // sizes in a local header can be zeroed when a data descriptor is used,
      // so the name and extra lengths are read from it but the sizes are not
      if (dv.getUint32(lho, true) !== 0x04034b50) throw new Error('Damaged entry: ' + name);
      const dataOff = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);

      entries.push({
        name, flags, method, time, date, crc, csize, usize, extAttr,
        data: u8.subarray(dataOff, dataOff + csize)
      });
      p += 46 + nlen + elen + clen;
    }
    return entries;
  }

  // Entries come out of readZip still compressed. This is the only way to get
  // at the bytes of one.
  async function readEntry(e) {
    if (e.method === 0) return e.data;
    if (e.method === 8) return inflateRaw(e.data);
    throw new Error('Unsupported compression method ' + e.method + ' for ' + e.name + '.');
  }

  // A new entry, stored rather than deflated. Png and the other asset formats
  // are compressed already and deflating them again buys nothing.
  function storedEntry(name, bytes, stamp) {
    return {
      name: name,
      flags: 0,
      method: 0,
      time: stamp ? stamp.time : 0,
      date: stamp ? stamp.date : 0,
      crc: crc32(bytes),
      csize: bytes.length,
      usize: bytes.length,
      extAttr: 0,
      data: bytes
    };
  }

  function writeZip(entries) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const e of entries) {
      const nameBytes = enc.encode(e.name);
      const flags = (e.flags & ~0x08) | (nameBytes.length !== e.name.length ? 0x800 : 0);
      const size = e.data.length;

      const lh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, flags, true);
      lv.setUint16(8, e.method, true);
      lv.setUint16(10, e.time, true);
      lv.setUint16(12, e.date, true);
      lv.setUint32(14, e.crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, e.usize, true);
      lv.setUint16(26, nameBytes.length, true);
      lh.set(nameBytes, 30);

      const ch = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, flags, true);
      cv.setUint16(10, e.method, true);
      cv.setUint16(12, e.time, true);
      cv.setUint16(14, e.date, true);
      cv.setUint32(16, e.crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, e.usize, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(38, e.extAttr >>> 0, true);
      cv.setUint32(42, offset, true);
      ch.set(nameBytes, 46);

      parts.push(lh, e.data);
      central.push(ch);
      offset += lh.length + size;
      if (offset > 0xFFFFFFFF) throw new Error('Archive exceeds 4 GB, which this writer does not support.');
    }

    const cdOffset = offset;
    let cdSize = 0;
    for (const c of central) { parts.push(c); cdSize += c.length; }

    const eo = new Uint8Array(22);
    const ev = new DataView(eo.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdOffset, true);
    parts.push(eo);

    return new Blob(parts, { type: 'application/x.scratch.sb3' });
  }

  /* ---------------------------------------------------------- block graph */

  // A floating reporter on the workspace serializes as [12, name, id, x, y].
  // scratch-vm appends x/y only when the primitive is topLevel (sb3.js:117),
  // so a 3 element [12, name, id] is not a visible block, it is residue.
  function isPositionedPrimitive(e) {
    return Array.isArray(e) && e.length >= 5;
  }

  function roots(blocks) {
    const out = [];
    for (const id of Object.keys(blocks)) {
      const b = blocks[id];
      if (Array.isArray(b)) {
        if (isPositionedPrimitive(b)) out.push(id);
      } else if (b.topLevel) {
        out.push(id);
      }
    }
    return out;
  }

  function children(b, blocks) {
    if (Array.isArray(b)) return [];
    const out = [];
    if (b.next) out.push(b.next);
    const inputs = b.inputs || {};
    for (const k of Object.keys(inputs)) {
      const inp = inputs[k];
      if (!Array.isArray(inp)) continue;
      for (let i = 1; i < inp.length; i++) {
        if (typeof inp[i] === 'string' && inp[i] in blocks) out.push(inp[i]);
      }
    }
    return out;
  }

  function reachable(blocks) {
    const seen = new Set();
    const stack = roots(blocks);
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id) || !(id in blocks)) continue;
      seen.add(id);
      for (const c of children(blocks[id], blocks)) stack.push(c);
    }
    return seen;
  }

  /* ----------------------------------------------------------- transforms */

  function sweepOrphans(target, stats) {
    const blocks = target.blocks;
    const live = reachable(blocks);
    const orphans = new Set(Object.keys(blocks).filter(id => !live.has(id)));

    // never sweep a block a comment is anchored to, it is visible in the editor
    const comments = target.comments || {};
    for (const cid of Object.keys(comments)) orphans.delete(comments[cid].blockId);

    // never sweep a block a survivor names as its parent, or getTopLevelScript
    // walks into a dangling pointer. Sparing one creates a new survivor, so loop.
    for (;;) {
      const protect = [];
      for (const id of Object.keys(blocks)) {
        if (orphans.has(id)) continue;
        const b = blocks[id];
        if (!Array.isArray(b) && b.parent != null && orphans.has(b.parent)) protect.push(b.parent);
      }
      if (!protect.length) break;
      for (const id of protect) orphans.delete(id);
    }

    for (const id of orphans) {
      const b = blocks[id];
      if (!Array.isArray(b) && b.comment && comments[b.comment]) comments[b.comment].blockId = null;
      delete blocks[id];
    }
    stats['orphan blocks removed'] = (stats['orphan blocks removed'] || 0) + orphans.size;
  }

  function bump(stats, k, n) { stats[k] = (stats[k] || 0) + (n === undefined ? 1 : n); }

  function pruneBlockKeys(target, stats, keepNext) {
    const blocks = target.blocks;
    for (const id of Object.keys(blocks)) {
      const b = blocks[id];
      if (Array.isArray(b)) continue;
      const out = {};
      for (const k of Object.keys(b)) {
        const v = b[k];
        if (k === 'next' && v === null && !keepNext) { bump(stats, '"next":null dropped'); continue; }
        if (k === 'inputs' && (!v || !Object.keys(v).length)) { bump(stats, '"inputs":{} dropped'); continue; }
        if (k === 'fields' && (!v || !Object.keys(v).length)) { bump(stats, '"fields":{} dropped'); continue; }
        if (k === 'shadow' && v === false) { bump(stats, '"shadow":false dropped'); continue; }
        if (k === 'topLevel' && v === false) { bump(stats, '"topLevel":false dropped'); continue; }
        // "parent":null is deliberately kept. Blocks.getTopLevelScript() runs
        // while (block.parent !== null), so an absent parent walks off the end.
        if (k === 'fields') {
          const f = {};
          for (const fn of Object.keys(v)) {
            const fa = v[fn];
            if (Array.isArray(fa) && fa.length > 1 && fa[1] === null) {
              f[fn] = fa.slice(0, 1);
              bump(stats, 'field trailing null dropped');
            } else {
              f[fn] = fa;
            }
          }
          out[k] = f;
          continue;
        }
        out[k] = v;
      }
      blocks[id] = out;
    }
  }

  // Half to even on exact ties, matching Python's round(). Values like 39.8125
  // are exactly representable and land exactly halfway, where Math.round would
  // go up and round() would go down. Keeping the two ports in agreement matters
  // more than which way a tie falls.
  function round3(v) {
    if (typeof v !== 'number' || !isFinite(v)) return v;
    const scaled = v * 1000;
    if (Math.abs(scaled % 1) === 0.5) {
      const down = Math.floor(scaled);
      return (down % 2 === 0 ? down : down + 1) / 1000;
    }
    return Math.round(scaled) / 1000;
  }

  function trimAssets(target, stats, dropSvgBitmapRes) {
    for (const c of target.costumes) {
      const fmt = c.dataFormat;
      // drop md5ext only when scratch-vm would rebuild the identical string
      if ('md5ext' in c && fmt && c.md5ext === c.assetId + '.' + fmt) {
        delete c.md5ext;
        bump(stats, 'costume md5ext dropped');
      }
      for (const k of ['rotationCenterX', 'rotationCenterY']) {
        if (typeof c[k] === 'number') {
          const r = round3(c[k]);
          if (String(r).length < String(c[k]).length) bump(stats, 'rotation centre floats trimmed');
          c[k] = r;
        }
      }
      if (dropSvgBitmapRes && fmt === 'svg' && c.bitmapResolution === 1) {
        delete c.bitmapResolution;
        bump(stats, 'svg bitmapResolution dropped');
      }
    }
    // sounds keep md5ext, scratch-vm reads it with no fallback (sb3.js:918)
    for (const k of ['x', 'y', 'size', 'direction', 'volume', 'tempo']) {
      if (k in target) target[k] = round3(target[k]);
    }
  }

  function shrink(project, opts) {
    opts = opts || {};
    const stats = {};
    for (const t of project.targets) {
      sweepOrphans(t, stats);
      pruneBlockKeys(t, stats, !!opts.keepNext);
      trimAssets(t, stats, !!opts.dropSvgBitmapRes);
    }
    return stats;
  }

  /* --------------------------------------------------------- verification */

  const eq = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

  // a block as scratch-vm holds it after deserializing, so that an explicit
  // null and an absent key compare equal
  function canon(b) {
    if (Array.isArray(b)) return JSON.stringify(['PRIM', b]);
    const fields = {};
    const f = b.fields || {};
    for (const fn of Object.keys(f)) {
      const fa = f[fn];
      fields[fn] = [fa[0], fa.length > 1 ? fa[1] : null];
    }
    return JSON.stringify([
      b.opcode ?? null, b.next ?? null, b.parent ?? null,
      b.inputs || {}, fields, !!b.shadow, !!b.topLevel,
      b.x ?? null, b.y ?? null, b.mutation ?? null, b.comment ?? null
    ]);
  }

  // structural problems, collected so we can fail only on ones we introduced
  function integrity(project) {
    const bad = new Set();
    for (const t of project.targets) {
      const blocks = t.blocks;
      for (const id of Object.keys(blocks)) {
        const b = blocks[id];
        if (Array.isArray(b)) continue;
        if (!('opcode' in b)) bad.add(t.name + '/' + id + ': no opcode');
        if (!('parent' in b)) bad.add(t.name + '/' + id + ": 'parent' key absent");
        const par = b.parent;
        if (par != null && !(par in blocks)) bad.add(t.name + '/' + id + ': dangling parent');
        if (!!b.topLevel !== (par == null)) bad.add(t.name + '/' + id + ': topLevel and parent disagree');
        if (b.next != null && !(b.next in blocks)) bad.add(t.name + '/' + id + ': dangling next');
        const inputs = b.inputs || {};
        for (const k of Object.keys(inputs)) {
          const inp = inputs[k];
          if (!Array.isArray(inp)) continue;
          for (let i = 1; i < inp.length; i++) {
            if (typeof inp[i] === 'string' && !(inp[i] in blocks)) {
              bad.add(t.name + '/' + id + ': dangling input ' + k);
            }
          }
        }
      }
      const comments = t.comments || {};
      for (const cid of Object.keys(comments)) {
        const bid = comments[cid].blockId;
        if (bid != null && !(bid in blocks)) bad.add(t.name + '/comment ' + cid + ': dangling anchor');
      }
    }
    return bad;
  }

  function verify(oldP, newP) {
    const bad = [];
    const chk = (c, m) => { if (!c) bad.push(m); };

    for (const k of ['extensions', 'meta', 'monitors', 'customFonts']) {
      chk(eq(oldP[k], newP[k]), 'top level ' + k + ' changed');
    }
    chk(oldP.targets.length === newP.targets.length, 'target count changed');
    if (bad.length) return { compared: 0, problems: bad };

    let compared = 0;
    for (let i = 0; i < oldP.targets.length; i++) {
      const ta = oldP.targets[i], tb = newP.targets[i];
      const n = ta.name;
      chk(n === tb.name, 'target order or name changed');
      for (const k of ['isStage', 'variables', 'lists', 'broadcasts', 'sounds',
                       'comments', 'currentCostume', 'layerOrder', 'visible',
                       'tempo', 'videoState', 'videoTransparency']) {
        chk(eq(ta[k], tb[k]), n + ': ' + k + ' changed');
      }

      chk(ta.costumes.length === tb.costumes.length, n + ': costume count changed');
      for (let j = 0; j < ta.costumes.length; j++) {
        const ca = ta.costumes[j], cb = tb.costumes[j];
        const nm = ca.name;
        for (const k of ['name', 'assetId', 'dataFormat', 'bitmapResolution']) {
          if (k === 'bitmapResolution' && !('bitmapResolution' in cb)) continue;
          chk(ca[k] === cb[k], n + '/' + nm + ': costume ' + k + ' changed');
        }
        const want = ca.md5ext || (ca.assetId + '.' + ca.dataFormat);
        const got = cb.md5ext || (cb.assetId + '.' + cb.dataFormat);
        chk(want === got, n + '/' + nm + ': md5ext not reconstructible');
        for (const k of ['rotationCenterX', 'rotationCenterY']) {
          const va = ca[k], vb = cb[k];
          chk((va === undefined) === (vb === undefined), n + '/' + nm + ': ' + k + ' appeared or vanished');
          if (va !== undefined && vb !== undefined) {
            chk(Math.abs(va - vb) <= 0.0005 + 1e-9, n + '/' + nm + ': ' + k + ' moved ' + va + ' to ' + vb);
          }
        }
      }
      for (let j = 0; j < ta.sounds.length; j++) {
        chk(('md5ext' in tb.sounds[j]) || !('md5ext' in ta.sounds[j]),
            n + '/' + ta.sounds[j].name + ': sound md5ext must never be dropped');
      }

      const ra = reachable(ta.blocks), rb = reachable(tb.blocks);
      chk(eq(roots(ta.blocks).slice().sort(), roots(tb.blocks).slice().sort()),
          n + ': set of top level scripts changed');
      chk(ra.size === rb.size && [...ra].every(id => rb.has(id)), n + ': set of live blocks changed');
      // The rule is that we only ever delete unreachable blocks, not that no
      // unreachable block survives. The sweep deliberately spares any orphan a
      // comment is anchored to or a survivor names as its parent, so a few
      // legitimately remain.
      for (const id of Object.keys(ta.blocks)) {
        if (!(id in tb.blocks) && ra.has(id)) bad.push(n + '/' + id + ': a live block was deleted');
      }
      for (const id of Object.keys(tb.blocks)) {
        if (!(id in ta.blocks)) bad.push(n + '/' + id + ': output has a block the input did not');
      }
      for (const id of ra) {
        if (!rb.has(id)) continue;
        if (canon(ta.blocks[id]) !== canon(tb.blocks[id])) bad.push(n + '/' + id + ': block content differs');
        compared++;
      }
    }

    const before = integrity(oldP);
    for (const p of integrity(newP)) if (!before.has(p)) bad.push(p);
    return { compared, problems: bad };
  }

  /* ------------------------------------------------------------ pipeline */

  async function process(buffer, opts, onStatus) {
    opts = opts || {};
    const say = onStatus || function () {};

    say('Reading archive');
    const entries = readZip(buffer);
    const pj = entries.find(e => e.name === 'project.json');
    if (!pj) throw new Error('No project.json inside.');

    say('Decompressing project.json');
    const raw = await readEntry(pj);

    const text = new TextDecoder().decode(raw);
    const before = raw.length;

    say('Parsing');
    const original = JSON.parse(text);
    const working = JSON.parse(text);

    say('Shrinking');
    const stats = shrink(working, opts);

    say('Serializing');
    let out = new TextEncoder().encode(JSON.stringify(working));

    say('Verifying');
    const { compared, problems } = verify(original, JSON.parse(new TextDecoder().decode(out)));
    if (problems.length) {
      const err = new Error('Verification failed, nothing was written.');
      err.problems = problems;
      throw err;
    }

    // Rasterizing and sound conversion rewrite assets on purpose, so they run
    // after the json has been proved identical and never before it. The check
    // below is what covers whatever they did.
    let raster = null;
    let sounds = null;
    if (opts.rasterize) raster = await opts.rasterize(entries, working, say);
    if (opts.sounds) sounds = await opts.sounds(entries, working, say);
    if (raster || sounds) out = new TextEncoder().encode(JSON.stringify(working));

    // every asset the new json asks for must still be in the archive
    const names = new Set(entries.map(e => e.name));
    const missing = [];
    for (const t of working.targets) {
      for (const c of t.costumes) {
        const md5 = c.md5ext || (c.assetId + '.' + c.dataFormat);
        if (!names.has(md5)) missing.push(md5);
      }
      for (const s of t.sounds) if (s.md5ext && !names.has(s.md5ext)) missing.push(s.md5ext);
    }
    if (missing.length) throw new Error(missing.length + ' referenced asset(s) are not in the archive, for example ' + missing[0]);

    say('Repacking');
    pj.data = await deflateRaw(out);
    pj.method = 8;
    pj.crc = crc32(out);
    pj.usize = out.length;
    const blob = writeZip(entries);

    return { blob, stats, compared, before, after: out.length, json: out, raster, sounds };
  }

  return {
    process, shrink, verify, readZip, writeZip, readEntry, storedEntry,
    reachable, roots, canon, integrity, crc32
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SB3;
