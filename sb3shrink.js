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

  // Which blocks the sweep would delete, worked out without touching anything.
  // The reporter asks the same question so it can stay quiet about residue that
  // is about to go: a warning you cannot act on is noise.
  function sweptOrphans(target) {
    const blocks = target.blocks;
    const live = reachable(blocks);
    const orphans = new Set(Object.keys(blocks).filter(id => !live.has(id)));
    const dead = orphans.size;
    const comments = target.comments || {};

    // who names each block as their parent. Built once, because sparing a block
    // spares everything hanging under it and that walk would otherwise rescan
    // every block once per level.
    const namedBy = new Map();
    for (const id of Object.keys(blocks)) {
      const b = blocks[id];
      if (Array.isArray(b)) continue;
      const par = b.parent;
      if (par == null || !(par in blocks)) continue;
      if (!namedBy.has(par)) namedBy.set(par, []);
      namedBy.get(par).push(id);
    }

    const work = [];
    const spare = id => { if (orphans.delete(id)) work.push(id); };

    // never sweep a block a comment is anchored to, it is visible in the editor
    for (const cid of Object.keys(comments)) spare(comments[cid].blockId);

    // An orphan that names a survivor as its parent is not residue, it is a
    // detached body: a script that is whole but hangs off one broken link. The
    // shape that forced this rule is a procedures_definition whose next was
    // repointed at a different definition's body, leaving its own body attached
    // by nothing but the parent pointer. Reachability calls that dead because
    // nothing renders it, and that is exactly what makes deleting it silent.
    // Residue proper still goes: a cluster whose head is attached to nothing.
    for (const id of [...orphans]) {
      const b = blocks[id];
      if (Array.isArray(b)) continue;
      const par = b.parent;
      if (par != null && (par in blocks) && !orphans.has(par)) spare(id);
    }

    // never sweep a block a survivor names as its parent, or getTopLevelScript
    // walks into a dangling pointer
    for (const id of Object.keys(blocks)) {
      if (orphans.has(id)) continue;
      const b = blocks[id];
      if (!Array.isArray(b) && b.parent != null && orphans.has(b.parent)) spare(b.parent);
    }

    // Sparing propagates. Whatever hangs under a spared block belongs to the
    // same detached script, found either through next and inputs or through the
    // parent pointers aimed back at it. Following both directions is also what
    // stops a spared block from keeping a reference to something deleted.
    while (work.length) {
      const id = work.pop();
      for (const c of children(blocks[id], blocks)) spare(c);
      for (const c of (namedBy.get(id) || [])) spare(c);
    }

    return { remove: orphans, dead: dead };
  }

  function sweepOrphans(target, stats) {
    const blocks = target.blocks;
    const comments = target.comments || {};
    const { remove, dead } = sweptOrphans(target);

    for (const id of remove) {
      const b = blocks[id];
      if (!Array.isArray(b) && b.comment && comments[b.comment]) comments[b.comment].blockId = null;
      delete blocks[id];
    }
    bump(stats, 'orphan blocks removed', remove.size);
    if (dead > remove.size) bump(stats, 'detached blocks kept', dead - remove.size);
  }

  function bump(stats, k, n) { stats[k] = (stats[k] || 0) + (n === undefined ? 1 : n); }

  function pruneBlockKeys(target, stats) {
    const blocks = target.blocks;
    for (const id of Object.keys(blocks)) {
      const b = blocks[id];
      if (Array.isArray(b)) continue;
      const out = {};
      for (const k of Object.keys(b)) {
        const v = b[k];
        if (k === 'next' && v === null) { bump(stats, '"next":null dropped'); continue; }
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

  function trimAssets(target, stats) {
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
      // Only ever the svg default. scratch-vm's vector path never reads the
      // field (load-costume.js loadVector_ takes the rotation centre straight
      // from the json), and editing the costume runs updateSvg, which writes
      // bitmapResolution = 1 back on. A costume that says 2 is left alone.
      if (fmt === 'svg' && c.bitmapResolution === 1) {
        delete c.bitmapResolution;
        bump(stats, 'svg bitmapResolution dropped');
      }
    }
    // sounds keep md5ext, scratch-vm reads it with no fallback (sb3.js:918)
    for (const k of ['x', 'y', 'size', 'direction', 'volume', 'tempo']) {
      if (k in target) target[k] = round3(target[k]);
    }
  }

  function shrink(project) {
    const stats = {};
    for (const t of project.targets) {
      sweepOrphans(t, stats);
      pruneBlockKeys(t, stats);
      trimAssets(t, stats);
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

        // A link has to agree in both directions. Where it does not, one block
        // is holding a pointer it does not own and whatever used to be on the
        // other end is sitting in the file with nothing rendering it. This is
        // the damage that hides a whole script from the editor while the
        // project still opens and still runs.
        if (b.next != null && (b.next in blocks)) {
          const nb = blocks[b.next];
          if (!Array.isArray(nb) && nb.parent !== id) {
            bad.add(t.name + '/' + id + ': next is ' + b.next + ', which belongs to ' + nb.parent);
          }
        }
        const inputs = b.inputs || {};
        for (const k of Object.keys(inputs)) {
          const inp = inputs[k];
          if (!Array.isArray(inp)) continue;
          for (let i = 1; i < inp.length; i++) {
            const ref = inp[i];
            if (typeof ref !== 'string') continue;
            if (!(ref in blocks)) { bad.add(t.name + '/' + id + ': dangling input ' + k); continue; }
            const cb = blocks[ref];
            if (!Array.isArray(cb) && cb.parent !== id) {
              bad.add(t.name + '/' + id + ': input ' + k + ' is ' + ref + ', which belongs to ' + cb.parent);
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
          // the only bitmapResolution that may go missing is the redundant 1 on
          // an svg. Gone from anything else and the comparison below catches it.
          if (k === 'bitmapResolution' && !('bitmapResolution' in cb) &&
              ca.dataFormat === 'svg' && ca.bitmapResolution === 1) continue;
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
      // Deleting is the one transform here that destroys information, so it is
      // audited on its own terms. Asking reachable() to confirm the sweep only
      // ever returns reachable()'s own answer, since it is the function that
      // picked the victims: any block it misjudges is missing from ra by
      // construction and the check below it would never fire. So the rule
      // checked here is about attachment instead, which reachability never
      // consults. A block may only vanish if nothing that survived was holding
      // it and it was holding nothing that survived. That covers the detached
      // body, whose parent is a live block, without knowing what a detached
      // body is.
      for (const id of Object.keys(ta.blocks)) {
        if (id in tb.blocks) continue;
        if (ra.has(id)) bad.push(n + '/' + id + ': a live block was deleted');
        const b = ta.blocks[id];
        if (Array.isArray(b)) continue;
        if (b.parent != null && (b.parent in tb.blocks)) {
          bad.push(n + '/' + id + ': deleted a block attached to surviving ' + b.parent);
        }
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

  /* ----------------------------------------------------------- describing */

  // integrity() names blocks by id because it is talking to verify(), which
  // only has to match a string against the same string from the pass before.
  // The report below is read by a person looking at their own project, where an
  // id like aq? appears nowhere and means nothing. So everything here is named
  // the way the editor names it: the sprite, the custom block signature with
  // its argument names filled in, the variable or list a block works on.

  // "THE BREEDER %s %s" with argument names ["Name","Level"] is written
  // "THE BREEDER (Name) (Level)" on the block itself, so write it that way.
  function prettyProccode(mutation) {
    if (!mutation || typeof mutation.proccode !== 'string') return null;
    let names = [];
    try { names = JSON.parse(mutation.argumentnames || '[]'); } catch (e) { names = []; }
    let i = 0;
    return mutation.proccode
      .replace(/%[%snb]/g, m => (m === '%%' ? '%' : '(' + (names[i++] || '') + ')'))
      .replace(/\s+/g, ' ')
      .trim();
  }

  function prototypeOf(b, blocks) {
    const cb = (b.inputs || {}).custom_block;
    if (!cb || typeof cb[1] !== 'string') return null;
    const p = blocks[cb[1]];
    return (p && !Array.isArray(p)) ? p : null;
  }

  // A script is found in the editor by its hat, so hats are worded the way the
  // hat itself is worded. The value in the named field is the part someone can
  // actually search their project for.
  const HATS = {
    event_whenflagclicked: () => 'when green flag clicked',
    event_whenthisspriteclicked: () => 'when this sprite clicked',
    event_whenstageclicked: () => 'when stage clicked',
    control_start_as_clone: () => 'when I start as a clone',
    event_whenbroadcastreceived: f => 'when I receive ' + f.BROADCAST_OPTION,
    event_whenkeypressed: f => 'when ' + f.KEY_OPTION + ' key pressed',
    event_whenbackdropswitchesto: f => 'when backdrop switches to ' + f.BACKDROP,
    event_whengreaterthan: f => 'when ' + (f.WHENGREATERTHANMENU || '').toLowerCase() + ' >'
  };

  // enough of the common stack blocks to read naturally, and a fallback that
  // drops the category prefix rather than inventing a name for every opcode
  const SHORT = {
    control_if: 'if', control_if_else: 'if/else', control_repeat: 'repeat',
    control_forever: 'forever', control_repeat_until: 'repeat until',
    control_wait: 'wait', control_wait_until: 'wait until',
    looks_switchcostumeto: 'switch costume to', looks_switchbackdropto: 'switch backdrop to',
    looks_switchbackdroptoandwait: 'switch backdrop to and wait',
    sound_play: 'start sound', sound_playuntildone: 'play sound until done',
    motion_goto: 'go to', motion_glideto: 'glide to', motion_pointtowards: 'point towards',
    sensing_touchingobject: 'touching', sensing_distanceto: 'distance to',
    sensing_of: 'of', control_create_clone_of: 'create clone of'
  };

  // A menu block carries the chosen name in a field. When that name is not in
  // the project any more the block still loads and still runs, it just quietly
  // does nothing, which is worth saying in those terms rather than in terms of
  // the pointer underneath.
  const MENU_FIELDS = {
    looks_costume: ['COSTUME', 'costume'],
    looks_backdrops: ['BACKDROP', 'backdrop'],
    event_whenbackdropswitchesto: ['BACKDROP', 'backdrop'],
    sound_sounds_menu: ['SOUND_MENU', 'sound'],
    motion_goto_menu: ['TO', 'sprite'],
    motion_glideto_menu: ['TO', 'sprite'],
    motion_pointtowards_menu: ['TOWARDS', 'sprite'],
    sensing_touchingobjectmenu: ['TOUCHINGOBJECTMENU', 'sprite'],
    sensing_distancetomenu: ['DISTANCETOMENU', 'sprite'],
    sensing_of_object_menu: ['OBJECT', 'sprite'],
    control_create_clone_of_menu: ['CLONE_OPTION', 'sprite']
  };

  // values the editor offers that name no asset at all
  const MENU_SPECIALS = {
    costume: ['next costume', 'previous costume', 'random costume'],
    backdrop: ['next backdrop', 'previous backdrop', 'random backdrop'],
    sprite: ['_mouse_', '_edge_', '_random_', '_myself_', '_stage_'],
    sound: []
  };

  // A costume, backdrop or sound name that parses as a number is used as a
  // 1 based index when no asset carries that name (looks.js _setCostume,
  // sound.js _getSoundIndex). Such a block still does something, so it is not a
  // dead reference and must never be offered up for deletion.
  function numericName(kind, value) {
    if (kind === 'sprite') return false;
    return value.trim() !== '' && !isNaN(Number(value));
  }

  // A block sitting at index 2 of an input is the shadow underneath whatever is
  // plugged into that slot. Nothing reads it while it is covered, so anything
  // wrong with it cannot change what the project does.
  function obscuredShadows(blocks) {
    const out = new Set();
    for (const id of Object.keys(blocks)) {
      const b = blocks[id];
      if (Array.isArray(b)) continue;
      for (const k of Object.keys(b.inputs || {})) {
        const inp = b.inputs[k];
        if (!Array.isArray(inp)) continue;
        for (let i = 2; i < inp.length; i++) {
          if (typeof inp[i] === 'string') out.add(inp[i]);
        }
      }
    }
    return out;
  }

  const NAMED_FIELDS = { VARIABLE: 'variable', LIST: 'list', BROADCAST_OPTION: 'broadcast' };

  // Input names are the json's, not the editor's. Where a slot is a visible
  // part of a block, say which part.
  const SLOTS = {
    custom_block: 'its heading',
    SUBSTACK: 'its inner blocks',
    SUBSTACK2: 'its else branch',
    CONDITION: 'its condition',
    TIMES: 'its repeat count',
    VALUE: 'its value slot',
    ITEM: 'its item slot',
    INDEX: 'its index slot',
    MESSAGE: 'its message slot',
    DURATION: 'its duration slot',
    SECS: 'its seconds slot',
    OPERAND1: 'its first slot',
    OPERAND2: 'its second slot'
  };

  function blockLabel(id, blocks) {
    const b = blocks[id];
    if (!b) return 'a block that is not in the project';
    if (Array.isArray(b)) return 'a loose reporter';
    const op = b.opcode || 'unknown';

    const fieldValues = {};
    for (const k of Object.keys(b.fields || {})) {
      const f = b.fields[k];
      if (Array.isArray(f)) fieldValues[k] = f[0];
    }
    if (HATS[op]) return HATS[op](fieldValues);

    if (op === 'procedures_definition') {
      const sig = prettyProccode((prototypeOf(b, blocks) || {}).mutation);
      return sig ? 'define ' + sig : 'a custom block definition';
    }
    if (op === 'procedures_prototype') {
      const sig = prettyProccode(b.mutation);
      return sig ? 'the heading of define ' + sig : 'a custom block heading';
    }
    if (op === 'procedures_call') {
      const sig = prettyProccode(b.mutation);
      return sig ? 'the ' + sig + ' block' : 'a custom block';
    }
    for (const k of Object.keys(NAMED_FIELDS)) {
      if (fieldValues[k]) {
        return 'the ' + (SHORT[op] || op.replace(/^[a-z]+_/, '')) + ' block on ' +
               NAMED_FIELDS[k] + ' ' + fieldValues[k];
      }
    }
    return 'the ' + (SHORT[op] || op.replace(/^[a-z]+_/, '')) + ' block';
  }

  // the top level block a block sits under, which is the script someone would
  // go looking for
  function scriptOf(id, blocks) {
    const seen = new Set();
    let cur = id;
    while (cur && (cur in blocks) && !seen.has(cur)) {
      seen.add(cur);
      const b = blocks[cur];
      if (Array.isArray(b) || b.parent == null || !(b.parent in blocks)) return cur;
      cur = b.parent;
    }
    return id;
  }

  // Every block hanging under an orphan, so the report can say how much code is
  // sitting behind a broken link rather than leaving it to be guessed at.
  function strandedUnder(blocks, live) {
    const counts = new Map();
    for (const id of Object.keys(blocks)) {
      if (live.has(id)) continue;
      const b = blocks[id];
      if (Array.isArray(b)) continue;
      const par = b.parent;
      if (par == null || !(par in blocks) || !live.has(par)) continue;
      const seen = new Set([id]);
      const stack = [id];
      while (stack.length) {
        for (const c of children(blocks[stack.pop()], blocks)) {
          if (!live.has(c) && !seen.has(c)) { seen.add(c); stack.push(c); }
        }
      }
      counts.set(par, (counts.get(par) || 0) + seen.size);
    }
    return counts;
  }

  // Findings come out as { level, text }.
  //   high  code is hidden or duplicated
  //   mid   the block runs and silently does nothing
  //   low   wrong in the file, never read
  // Sorting these apart matters more than finding more of them. A list where
  // everything looks equally alarming gets read once and ignored after that.
  function describeDamage(project) {
    const out = [];
    const stage = project.targets.filter(t => t.isStage)[0] || project.targets[0];
    const backdrops = new Set((stage.costumes || []).map(c => c.name));
    // "of" offers the stage alongside the sprites, and it is named there the
    // way it is named in the project, so the stage counts as a valid choice
    const sprites = new Set(project.targets.map(t => t.name));
    sprites.add('Stage');

    for (const t of project.targets) {
      const blocks = t.blocks;
      const live = reachable(blocks);
      const stranded = strandedUnder(blocks, live);
      const covered = obscuredShadows(blocks);
      const going = sweptOrphans(t).remove;
      const faults = new Map();
      const known = {
        costume: new Set((t.costumes || []).map(c => c.name)),
        sound: new Set((t.sounds || []).map(s => s.name)),
        backdrop: backdrops,
        sprite: sprites
      };

      for (const id of Object.keys(blocks)) {
        const b = blocks[id];
        if (Array.isArray(b) || going.has(id)) continue;

        // a menu naming something that is not in the project any more
        const rule = MENU_FIELDS[b.opcode];
        if (rule) {
          const field = (b.fields || {})[rule[0]];
          const value = Array.isArray(field) ? field[0] : null;
          const kind = rule[1];
          if (typeof value === 'string' && value !== '' &&
              MENU_SPECIALS[kind].indexOf(value) < 0 && !known[kind].has(value) &&
              !numericName(kind, value)) {
            const holder = (b.parent != null && (b.parent in blocks)) ? b.parent : id;
            const script = blockLabel(scriptOf(holder, blocks), blocks);
            const what = blockLabel(holder, blocks);
            const hidden = covered.has(id);
            out.push({
              level: hidden ? 'low' : 'mid',
              text: t.name + ' › "' + script + '" - ' + what + ' names ' + kind + ' "' +
                value + '", which no longer exists. ' +
                (hidden ? 'The slot is covered, so the name is never read.'
                        : 'It runs and does nothing.')
            });
          }
        }

        const note = (what, ref) => {
          const cb = blocks[ref];
          if (!cb || Array.isArray(cb) || cb.parent === id || going.has(ref)) return;
          if (!faults.has(id)) faults.set(id, { what: [], owner: cb.parent, real: false });
          const f = faults.get(id);
          f.what.push(what);
          // a shadow is a menu or a literal, never a script. Its pointers going
          // stale loses nobody any code.
          if (!cb.shadow) f.real = true;
        };
        if (b.next != null && (b.next in blocks)) note('the block under it', b.next);
        const inputs = b.inputs || {};
        for (const k of Object.keys(inputs)) {
          const inp = inputs[k];
          if (!Array.isArray(inp)) continue;
          for (let i = 1; i < inp.length; i++) {
            const ref = inp[i];
            if (typeof ref !== 'string') continue;
            if (ref in blocks) { note(SLOTS[k] || 'its ' + k + ' slot', ref); continue; }

            // An input naming a block the file does not contain. Scratch draws
            // nothing for it, so the first slot goes visibly blank on the
            // workspace and the rest, being underneath whatever covers them,
            // go nowhere anyone can see. Only worth saying for a block that is
            // drawn at all.
            if (!live.has(id)) continue;
            const where = SLOTS[k] || 'its ' + k + ' slot';
            const me = blockLabel(id, blocks);
            const script = blockLabel(scriptOf(id, blocks), blocks);
            out.push(i === 1
              ? { level: 'high',
                  text: t.name + ' › "' + script + '" - ' + me + ': ' + where +
                        ' is empty. Whatever was in it is not in the file and cannot ' +
                        'be recovered, so it has to be typed back in.' }
              : { level: 'low',
                  text: t.name + ' › "' + script + '" - ' + me + ': the value hidden ' +
                        'under ' + where + ' is not in the file. Nothing reads it.' });
          }
        }
      }

      for (const [id, f] of faults) {
        const mine = scriptOf(id, blocks);
        const script = blockLabel(mine, blocks);

        // Where the stolen code actually lives. Naming the owning script beats
        // naming the owning block: two repeat blocks read alike, but the hat
        // above them is the thing someone can go and find.
        let owner;
        if (f.owner == null || !(f.owner in blocks)) {
          owner = 'a block that is no longer in the project';
        } else {
          const theirs = scriptOf(f.owner, blocks);
          const label = blockLabel(theirs, blocks);
          owner = theirs === mine ? 'another part of this same script'
                : label === script ? 'a second copy of this same script'
                : '"' + label + '"';
        }

        // "its inner blocks" is already plural, so the verb cannot just follow
        // how many pointers are being listed
        const plural = f.what.length > 1 || /blocks$/.test(f.what[0]);
        const lost = stranded.get(id) || 0;

        let msg = t.name + ' › "' + script + '" - ';
        if (id !== mine) msg += blockLabel(id, blocks) + ' inside it: ';
        msg += f.what.join(' and ') + (plural ? ' point' : ' points') +
               ' at code owned by ' + owner + '.';

        // Only a pointer at a real block can cost anything. When every one of
        // them lands on a shadow, all that is wrong is the bookkeeping under a
        // menu or a literal, and no code is hiding anywhere.
        if (!f.real && !lost) {
          out.push({ level: 'low', text: msg + ' All menus or typed values, so no code is affected.' });
          continue;
        }

        out.push({
          level: 'high',
          text: msg + (lost
            ? ' ' + lost + ' block' + (lost === 1 ? '' : 's') + ' detached, drawn nowhere in the editor.'
            : ' Nothing left attached, so whatever was there is already gone.')
        });
      }
    }
    // the same mistake repeated across a sprite is one mistake, not twenty five
    const merged = new Map();
    for (const f of out) {
      const key = f.level + '\u0000' + f.text;
      if (merged.has(key)) merged.get(key).count++;
      else merged.set(key, { level: f.level, text: f.text, count: 1 });
    }

    // worst first, so the thing worth acting on is not below a list of trivia
    const rank = { high: 0, mid: 1, low: 2 };
    return [...merged.values()]
      .map(f => ({ level: f.level, text: f.count > 1 ? f.text + ' \u00d7' + f.count : f.text }))
      .sort((a, b) => rank[a.level] - rank[b.level]);
  }

  /* -------------------------------------------------------------- cleanup */

  // The one pass here that removes something on purpose. It is opt in, it never
  // runs as part of shrinking, and it only ever takes a copy: a definition
  // whose own pointers aim at blocks some other block owns, together with the
  // code hanging under it. The copy that still owns its body is left alone.

  // The top of every block's parent chain, memoised, so ownership is known
  // after one pass instead of one walk per definition.
  function parentRoots(blocks) {
    const root = new Map();
    for (const start of Object.keys(blocks)) {
      if (root.has(start)) continue;
      const path = [];
      const onPath = new Set();
      let cur = start, top;
      for (;;) {
        if (root.has(cur)) { top = root.get(cur); break; }
        if (onPath.has(cur)) { top = cur; break; }        // parent cycle
        const b = blocks[cur];
        if (Array.isArray(b)) { top = cur; break; }
        path.push(cur);
        onPath.add(cur);
        const par = b.parent;
        if (par == null || !(par in blocks)) { top = cur; break; }
        cur = par;
      }
      for (const p of path) root.set(p, top);
    }
    return root;
  }

  // A copy holds ids it is not entitled to: the block it points at names a
  // different parent, and that parent's own pointer agrees with it, so the
  // original is whole and the copy is the odd one out.
  function brokenDuplicates(project) {
    const jobs = [];
    for (const t of project.targets) {
      const blocks = t.blocks;
      const root = parentRoots(blocks);
      const owned = new Map();
      for (const id of Object.keys(blocks)) {
        const r = root.get(id);
        if (r === undefined || r === id) continue;
        if (!owned.has(r)) owned.set(r, new Set());
        owned.get(r).add(id);
      }
      for (const id of Object.keys(blocks)) {
        const b = blocks[id];
        if (Array.isArray(b) || b.opcode !== 'procedures_definition') continue;
        let broken = false;
        for (const ref of children(b, blocks)) {
          const rb = blocks[ref];
          if (!Array.isArray(rb) && rb.parent !== id) { broken = true; break; }
        }
        if (!broken) continue;
        const remove = new Set(owned.get(id) || []);
        remove.add(id);
        jobs.push({ target: t, id: id, label: blockLabel(id, blocks), remove: remove });
      }
    }
    return jobs;
  }

  function proccodeOf(id, blocks) {
    const b = blocks[id];
    if (!b || Array.isArray(b)) return null;
    const p = prototypeOf(b, blocks);
    return p && p.mutation ? p.mutation.proccode : null;
  }

  function cleanDuplicates(project) {
    const done = [], skipped = [];
    for (const job of brokenDuplicates(project)) {
      const blocks = job.target.blocks;
      const rm = job.remove;

      // A copy is only ever a copy if the thing it copies is still there. If
      // this is somehow the last definition of its custom block, every call to
      // that block would be left with nothing to run, so it stays regardless of
      // what its pointers look like.
      const code = proccodeOf(job.id, blocks);
      let survivors = 0;
      for (const id of Object.keys(blocks)) {
        const b = blocks[id];
        if (rm.has(id) || Array.isArray(b) || b.opcode !== 'procedures_definition') continue;
        if (proccodeOf(id, blocks) === code) survivors++;
      }
      if (!survivors) {
        skipped.push({
          target: job.target.name, label: job.label,
          why: 'it is the only definition of that block left'
        });
        continue;
      }

      // nothing outside the set may point into it
      let intruder = null;
      for (const id of Object.keys(blocks)) {
        if (rm.has(id) || Array.isArray(blocks[id])) continue;
        for (const ref of children(blocks[id], blocks)) {
          if (rm.has(ref)) { intruder = id; break; }
        }
        if (intruder) break;
      }

      // nothing inside it may still be reachable once the copy's own root goes
      const seen = new Set();
      const stack = roots(blocks).filter(r => !rm.has(r));
      while (stack.length) {
        const x = stack.pop();
        if (seen.has(x) || !(x in blocks)) continue;
        seen.add(x);
        for (const c of children(blocks[x], blocks)) stack.push(c);
      }
      let leak = null;
      for (const id of rm) if (seen.has(id)) { leak = id; break; }

      // a comment anchored inside it is something visible on the workspace
      const comments = job.target.comments || {};
      let anchored = null;
      for (const cid of Object.keys(comments)) {
        if (rm.has(comments[cid].blockId)) { anchored = cid; break; }
      }

      if (intruder || leak || anchored) {
        skipped.push({
          target: job.target.name, label: job.label,
          why: intruder ? 'something outside it points into it'
             : leak ? 'part of it is still reachable from another script'
             : 'a comment is attached to it'
        });
        continue;
      }

      for (const id of rm) delete blocks[id];
      done.push({ target: job.target.name, label: job.label, removed: rm.size });
    }
    return { done, skipped, removed: done.reduce((n, d) => n + d.removed, 0) };
  }

  /* ------------------------------------------------------- repair, delete */

  // Who points at each block, through which slot, and how many do. The count
  // matters: this project family has blocks named by two different slots at
  // once, and for those there is no single right answer to "who holds it", so
  // nothing may be repaired or spliced on their behalf.
  function referrers(blocks) {
    const at = new Map();
    const note = (ref, rec) => {
      const had = at.get(ref);
      if (had) had.n++;
      else at.set(ref, rec);
    };
    for (const id of Object.keys(blocks)) {
      const b = blocks[id];
      if (Array.isArray(b)) continue;
      if (b.next != null && (b.next in blocks)) note(b.next, { by: id, slot: 'next', n: 1 });
      for (const k of Object.keys(b.inputs || {})) {
        const inp = b.inputs[k];
        if (!Array.isArray(inp)) continue;
        for (let i = 1; i < inp.length; i++) {
          if (typeof inp[i] === 'string' && (inp[i] in blocks)) {
            note(inp[i], { by: id, slot: k, index: i, n: 1 });
          }
        }
      }
    }
    return at;
  }

  // Green work: references that are wrong in the file and never read. A shadow
  // whose parent has gone stale gets pointed back at whatever holds it, and a
  // covered menu naming a deleted asset gets an asset that exists. Neither can
  // change what the project does, because nothing executes either one.
  function coveredFixes(project) {
    const jobs = [];
    const stage = project.targets.filter(t => t.isStage)[0] || project.targets[0];
    for (const t of project.targets) {
      const blocks = t.blocks;
      const at = referrers(blocks);
      const covered = obscuredShadows(blocks);
      const going = sweptOrphans(t).remove;

      for (const id of Object.keys(blocks)) {
        const b = blocks[id];
        if (Array.isArray(b) || going.has(id)) continue;

        const ref = at.get(id);
        if (b.shadow && ref && ref.n === 1 && b.parent !== ref.by) {
          jobs.push({ target: t, id: id, kind: 'parent', to: ref.by,
                      label: blockLabel(id, blocks) });
        }

        // A shadow reference the file does not contain, sitting under whatever
        // covers it. sb3 already has a form for "a block here and nothing
        // underneath it", so the dangling id is dropped rather than a value
        // being invented: [3, block, gone] becomes [2, block].
        for (const k of Object.keys(b.inputs || {})) {
          const inp = b.inputs[k];
          if (!Array.isArray(inp) || inp[0] !== 3 || inp.length !== 3) continue;
          if (typeof inp[2] !== 'string' || (inp[2] in blocks)) continue;
          jobs.push({ target: t, id: id, kind: 'shadow', slot: k, was: inp[2],
                      label: blockLabel(id, blocks) });
        }

        const rule = MENU_FIELDS[b.opcode];
        if (!rule || !covered.has(id)) continue;
        const field = (b.fields || {})[rule[0]];
        const value = Array.isArray(field) ? field[0] : null;
        const kind = rule[1];
        if (typeof value !== 'string' || value === '') continue;
        if (MENU_SPECIALS[kind].indexOf(value) >= 0 || numericName(kind, value)) continue;

        // the stage owns backdrops, a sprite owns its own costumes and sounds.
        // A sprite menu has no safe default, so those are reported and left.
        const pool = kind === 'backdrop' ? (stage.costumes || [])
                   : kind === 'costume' ? (t.costumes || [])
                   : kind === 'sound' ? (t.sounds || [])
                   : null;
        if (!pool || !pool.length) continue;
        if (pool.some(a => a.name === value)) continue;

        const holder = (b.parent != null && (b.parent in blocks)) ? b.parent : id;
        jobs.push({ target: t, id: id, kind: 'name', field: rule[0], was: value,
                    to: pool[0].name, what: kind, label: blockLabel(holder, blocks) });
      }
    }
    return jobs;
  }

  function fixCoveredRefs(project) {
    const done = [];
    for (const job of coveredFixes(project)) {
      const blocks = job.target.blocks;
      const b = blocks[job.id];
      if (!b) continue;
      if (job.kind === 'parent') {
        b.parent = job.to;
        done.push({ target: job.target.name, label: job.label,
                    what: 'owner corrected' });
      } else if (job.kind === 'shadow') {
        const inp = (b.inputs || {})[job.slot];
        if (!Array.isArray(inp) || inp[0] !== 3 || inp[2] !== job.was) continue;
        b.inputs[job.slot] = [2, inp[1]];
        done.push({ target: job.target.name, label: job.label,
                    what: 'dropped a hidden value that is not in the file' });
      } else {
        b.fields[job.field][0] = job.to;
        done.push({ target: job.target.name, label: job.label,
                    what: job.what + ' "' + job.was + '" → "' + job.to + '"' });
      }
    }
    return { done, fixed: done.length };
  }

  // Yellow work: a block whose dropdown names something the project no longer
  // has, with nothing covering it, so it runs and does nothing. Only a block
  // sitting in a stack can go, because splicing one out of a sequence is
  // well defined and pulling a reporter out of a slot is not.
  function deadBlocks(project) {
    const jobs = [];
    const stage = project.targets.filter(t => t.isStage)[0] || project.targets[0];
    const sprites = new Set(project.targets.map(t => t.name));
    sprites.add('Stage');

    for (const t of project.targets) {
      const blocks = t.blocks;
      const at = referrers(blocks);
      const covered = obscuredShadows(blocks);
      const going = sweptOrphans(t).remove;
      const known = {
        costume: new Set((t.costumes || []).map(c => c.name)),
        sound: new Set((t.sounds || []).map(s => s.name)),
        backdrop: new Set((stage.costumes || []).map(c => c.name)),
        sprite: sprites
      };

      for (const id of Object.keys(blocks)) {
        const m = blocks[id];
        if (Array.isArray(m) || going.has(id) || covered.has(id)) continue;
        const rule = MENU_FIELDS[m.opcode];
        if (!rule) continue;
        const field = (m.fields || {})[rule[0]];
        const value = Array.isArray(field) ? field[0] : null;
        const kind = rule[1];
        if (typeof value !== 'string' || value === '') continue;
        if (MENU_SPECIALS[kind].indexOf(value) >= 0 || known[kind].has(value)) continue;
        if (numericName(kind, value)) continue;

        const bid = m.parent;
        const b = bid != null ? blocks[bid] : null;
        if (!b || Array.isArray(b) || b.shadow || b.topLevel || going.has(bid)) continue;
        const ref = at.get(bid);
        if (!ref || ref.n !== 1) continue;
        if (ref.slot !== 'next' && ref.slot.indexOf('SUBSTACK') !== 0) continue;

        jobs.push({ target: t, id: bid, ref: ref, value: value, what: kind,
                    label: blockLabel(bid, blocks),
                    script: blockLabel(scriptOf(bid, blocks), blocks) });
      }
    }
    return jobs;
  }

  function deleteDeadBlocks(project) {
    const done = [], skipped = [];
    for (const job of deadBlocks(project)) {
      const blocks = job.target.blocks;
      const b = blocks[job.id];
      if (!b) continue;
      const nxt = (b.next != null && (b.next in blocks)) ? b.next : null;

      // everything under this block except the stack that continues past it
      const rm = new Set([job.id]);
      const stack = children(b, blocks).filter(c => c !== nxt);
      while (stack.length) {
        const x = stack.pop();
        if (rm.has(x) || !(x in blocks) || x === nxt) continue;
        rm.add(x);
        for (const c of children(blocks[x], blocks)) if (c !== nxt) stack.push(c);
      }

      // Refuse if anything outside points in, or names one of these as its
      // parent, or has a comment on it. The parent case is the one that bites:
      // a detached block the sweep deliberately spares can still claim this
      // block as its owner, and deleting underneath it strands the pointer.
      let blocked = null;
      for (const id of Object.keys(blocks)) {
        if (rm.has(id) || Array.isArray(blocks[id])) continue;
        const par = blocks[id].parent;
        if (par != null && rm.has(par) && id !== nxt) { blocked = id; break; }
        for (const c of children(blocks[id], blocks)) {
          if (rm.has(c) && !(id === job.ref.by && c === job.id)) { blocked = id; break; }
        }
        if (blocked) break;
      }
      const comments = job.target.comments || {};
      for (const cid of Object.keys(comments)) {
        if (rm.has(comments[cid].blockId)) blocked = blocked || 'a comment';
      }
      if (blocked) {
        skipped.push({ target: job.target.name, label: job.label,
                       why: 'something else is attached to it' });
        continue;
      }

      // close the gap the block leaves behind
      const p = blocks[job.ref.by];
      if (job.ref.slot === 'next') {
        p.next = nxt;
      } else if (nxt) {
        p.inputs[job.ref.slot][job.ref.index] = nxt;
      } else {
        delete p.inputs[job.ref.slot];
      }
      if (nxt) blocks[nxt].parent = job.ref.by;

      for (const id of rm) delete blocks[id];
      done.push({ target: job.target.name, label: job.label, script: job.script,
                  what: job.what, value: job.value, removed: rm.size });
    }
    return { done, skipped, removed: done.reduce((n, d) => n + d.removed, 0) };
  }

  /* ------------------------------------------------------------ pipeline */

  // Everything that can be known before anything expensive happens: what is
  // wrong and what could be done about it. Rasterizing and sound conversion are
  // the slow passes, so the decisions get made ahead of them and they run once.
  async function analyse(buffer) {
    const entries = readZip(buffer);
    const pj = entries.find(e => e.name === 'project.json');
    if (!pj) throw new Error('No project.json inside.');
    const project = JSON.parse(new TextDecoder().decode(await readEntry(pj)));
    return {
      damaged: describeDamage(project),
      cleanable: brokenDuplicates(project).length,
      deletable: deadBlocks(project).length,
      fixable: coveredFixes(project).length
    };
  }

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
    const parsed = JSON.parse(text);

    // Damage the file arrived with, described before anything touches it. None
    // of it is caused by shrinking, and a project holding links that disagree
    // has code the editor cannot show, which is what a sweep is most likely to
    // mistake for residue. Report it rather than carry it through in silence:
    // after the pass it is much harder to notice.
    const damaged = describeDamage(parsed);
    const cleanable = brokenDuplicates(parsed).length;
    const deletable = deadBlocks(parsed).length;
    const fixable = coveredFixes(parsed).length;

    // Cleaning is deliberate destruction, so it happens here, before the pair
    // of copies the verifier compares. Everything downstream then has to come
    // out identical to the cleaned project, which keeps shrinking held to the
    // same standard it was always held to and keeps the two jobs separable.
    let cleaned = null, deleted = null, fixed = null;
    if (opts.cleanDuplicates) {
      say('Removing broken duplicate scripts');
      cleaned = cleanDuplicates(parsed);
    }
    if (opts.deleteDead) {
      say('Deleting blocks that do nothing');
      deleted = deleteDeadBlocks(parsed);
    }
    if (opts.fixCovered) {
      say('Repairing covered references');
      fixed = fixCoveredRefs(parsed);
    }
    const edited = (cleaned && cleaned.removed) || (deleted && deleted.removed) ||
                   (fixed && fixed.fixed);
    if (cleaned || deleted || fixed) {
      const rest = describeDamage(parsed);
      if (cleaned) cleaned.remaining = rest;
      if (deleted) deleted.remaining = rest;
      if (fixed) fixed.remaining = rest;
    }

    const baseText = edited ? JSON.stringify(parsed) : text;
    const original = JSON.parse(baseText);
    const working = JSON.parse(baseText);

    say('Shrinking');
    const stats = shrink(working);

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

    return { blob, stats, compared, before, after: out.length, json: out, raster, sounds,
             damaged, cleanable, deletable, fixable, cleaned, deleted, fixed };
  }

  return {
    process, analyse, shrink, verify, readZip, writeZip, readEntry, storedEntry,
    reachable, roots, canon, integrity, describeDamage,
    brokenDuplicates, cleanDuplicates, sweptOrphans,
    deadBlocks, deleteDeadBlocks, coveredFixes, fixCoveredRefs, crc32
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SB3;
