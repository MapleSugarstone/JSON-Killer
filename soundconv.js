/*
 * Re-encodes sounds as mono mp3. Optional, and like rasterize.js it needs the
 * DOM: the browser decodes whatever the sound already is and lamejs encodes
 * what comes back. It changes assets, never the shape of the json, so it runs
 * only after the json has been verified untouched.
 *
 * Two things are worth knowing before reading any of it.
 *
 * Scratch's own library sounds are 22 kHz adpcm, which is about 88 kbps. A
 * 128 kbps mp3 of one is bigger, so a project built from the library mostly
 * comes back untouched, and that is the correct answer rather than a failure.
 * What this is for is imported and recorded sound, which arrives as 44.1 kHz
 * stereo pcm at 1411 kbps and comes out eleven times smaller.
 *
 * lamejs sets bWriteVbrTag false, so it emits no Xing header, and the encoder
 * delay it does not declare is real: measured through decodeAudioData, a raw
 * lamejs mp3 starts 1105 samples late and decodes longer than it went in, at
 * every sample rate. That is 25 ms of silence on the front of every sound at
 * 44.1 kHz and 100 ms at 11 kHz, which for a project full of short effects is
 * not survivable. tagFrame() writes the Info/LAME frame lamejs leaves out. With
 * it in place decodeAudioData returns exactly the sample count that went in,
 * aligned to sample zero. scratch-vm decodes sounds with decodeAudioData as
 * well, in AudioEngine.decodeSound, so that measurement is what Scratch does.
 *
 * MIT licensed. See LICENSE. Uses lamejs, which is LGPL and kept unmodified in
 * lame.min.js.
 */
const SOUND = (function () {
  'use strict';

  // Only these exist in mp3. Anything else has to be resampled on the way in.
  const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

  function nearestRate(r) {
    let best = 44100, gap = Infinity;
    for (const c of MP3_RATES) {
      const d = Math.abs(c - r);
      if (d < gap) { gap = d; best = c; }
    }
    return best;
  }

  /* ------------------------------------------------------------------ riff */

  const four = (b, at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

  // The first chunk of each id, which is all a wav ever has.
  function riffChunks(b) {
    if (b.length < 12 || four(b, 0) !== 'RIFF' || four(b, 8) !== 'WAVE') return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const out = {};
    let p = 12;
    while (p + 8 <= b.length) {
      const id = four(b, p);
      let size = dv.getUint32(p + 4, true);
      const start = p + 8;
      // a truncated last chunk still holds usable audio, so take what is there
      if (start + size > b.length) size = b.length - start;
      if (!(id in out)) out[id] = b.subarray(start, start + size);
      p = start + size + (size & 1);
    }
    return out;
  }

  function wavFormat(b) {
    const c = riffChunks(b);
    if (!c || !c['fmt '] || c['fmt '].length < 16) return null;
    const f = c['fmt '];
    const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
    let tag = dv.getUint16(0, true);
    // WAVE_FORMAT_EXTENSIBLE keeps the real tag in the first two bytes of its
    // SubFormat guid
    if (tag === 0xFFFE && f.length >= 26) tag = dv.getUint16(24, true);
    return {
      tag: tag,
      channels: dv.getUint16(2, true),
      rate: dv.getUint32(4, true),
      blockAlign: dv.getUint16(12, true),
      samplesPerBlock: f.length >= 20 ? dv.getUint16(18, true) : 0,
      data: c.data || null
    };
  }

  /* ----------------------------------------------------------------- adpcm */

  // A browser cannot decode ima adpcm, and it is the format most of a Scratch
  // project is in, so this is not an edge case. Ported from scratch-vm's
  // ADPCMSoundDecoder, quirks included, because what matters is reproducing the
  // sound the project actually plays rather than the sound the file describes.
  const STEP_TABLE = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
    19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
    130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
    337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
    876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
    2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
    5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
    15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767
  ];
  const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8];

  function imaDecode(data, blockSize) {
    const out = [];
    if (!(blockSize > 0)) return out;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let sample = 0, index = 0, lastByte = -1, pos = 0;

    for (;;) {
      if ((pos % blockSize) === 0 && lastByte < 0) {
        if (pos + 4 > data.length) break;
        sample = dv.getInt16(pos, true);
        index = data[pos + 2];
        pos += 4;                       // int16 sample, uint8 index, one unused
        if (index > 88) index = 88;
        out.push(sample / 32768);
      } else {
        let code;
        if (lastByte < 0) {
          if (pos >= data.length) break;
          lastByte = data[pos++];
          code = lastByte & 0xF;
        } else {
          code = (lastByte >> 4) & 0xF;
          lastByte = -1;
        }
        const step = STEP_TABLE[index];
        let delta = step >> 3;
        if (code & 4) delta += step;
        if (code & 2) delta += step >> 1;
        if (code & 1) delta += step >> 2;
        sample += (code & 8) ? -delta : delta;
        if (sample > 32767) sample = 32767;
        else if (sample < -32768) sample = -32768;
        index += INDEX_TABLE[code & 7];
        if (index > 88) index = 88;
        else if (index < 0) index = 0;
        out.push(sample / 32768);
      }
    }
    return out;
  }

  /* --------------------------------------------------------------- decoding */

  const ctxCache = new Map();
  function ctxAt(rate) {
    if (!ctxCache.has(rate)) ctxCache.set(rate, new OfflineAudioContext(1, 1, rate));
    return ctxCache.get(rate);
  }

  // Safari answered with a callback long before it answered with a promise.
  function decodeAudioData(ctx, buf) {
    return new Promise((res, rej) => {
      const p = ctx.decodeAudioData(buf, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  }

  const MPEG_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };
  const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];

  // Layer III only, which is the only thing lamejs writes and the only thing
  // that reaches an sb3 in practice.
  function frameAt(b, at) {
    if (at + 4 > b.length || b[at] !== 0xFF || (b[at + 1] & 0xE0) !== 0xE0) return null;
    const vb = (b[at + 1] >> 3) & 3;
    if (vb === 1) return null;
    if (((b[at + 1] >> 1) & 3) !== 1) return null;
    const ver = vb === 3 ? 1 : vb === 2 ? 2 : 25;
    const brIx = (b[at + 2] >> 4) & 0xF;
    const rIx = (b[at + 2] >> 2) & 3;
    if (brIx === 0 || brIx === 15 || rIx === 3) return null;
    const rate = MPEG_RATES[ver][rIx];
    const kbps = (ver === 1 ? BR1 : BR2)[brIx];
    const mono = ((b[at + 3] >> 6) & 3) === 3;
    return {
      ver: ver, rate: rate, kbps: kbps, mono: mono,
      spf: ver === 1 ? 1152 : 576,
      len: Math.floor((ver === 1 ? 144000 : 72000) * kbps / rate) + ((b[at + 2] >> 1) & 1),
      side: ver === 1 ? (mono ? 17 : 32) : (mono ? 9 : 17)
    };
  }

  function mp3Rate(b) {
    let p = 0;
    // an id3v2 tag sits in front of the audio and its length is synchsafe
    if (b.length > 10 && four(b, 0).slice(0, 3) === 'ID3') {
      p = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]);
    }
    for (let i = p; i < Math.min(b.length - 4, p + 65536); i++) {
      const f = frameAt(b, i);
      if (f) return f.rate;
    }
    return 0;
  }

  // The rate the source is already at, so that nothing is resampled for the
  // sake of it. Zero when we cannot tell.
  function sourceRate(bytes) {
    const w = wavFormat(bytes);
    if (w && w.rate) return w.rate;
    return mp3Rate(bytes);
  }

  function toMono(chans, length) {
    if (chans.length === 1) return chans[0];
    const out = new Float32Array(length);
    for (const c of chans) for (let i = 0; i < length; i++) out[i] += c[i];
    // A plain average, which is what a downmix is. Two channels recorded out of
    // phase with each other will cancel, and no downmix anywhere avoids that.
    const k = 1 / chans.length;
    for (let i = 0; i < length; i++) out[i] *= k;
    return out;
  }

  async function resample(mono, from, to) {
    if (from === to) return mono;
    const len = Math.max(1, Math.round(mono.length * to / from));
    const ctx = new OfflineAudioContext(1, len, to);
    const buf = ctx.createBuffer(1, mono.length, from);
    buf.copyToChannel(mono, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    return (await ctx.startRendering()).getChannelData(0);
  }

  // Mono float samples at a rate mp3 can actually hold.
  async function decode(bytes) {
    const rate = nearestRate(sourceRate(bytes) || 44100);
    const w = wavFormat(bytes);

    if (w && w.tag === 0x11) {
      if (!w.data) return { error: 'adpcm wav with no data chunk' };
      // scratch-vm derives the block size from samplesPerBlock rather than
      // trusting blockAlign, so decoding matches Scratch only if we do too.
      let block = ((w.samplesPerBlock - 1) / 2) + 4;
      if (!(block > 4) || block !== Math.floor(block)) block = w.blockAlign;
      if (!(block > 4)) return { error: 'adpcm wav with an unreadable block size' };
      // scratch-vm's decoder reads one interleaved stream and calls it mono, so
      // for a stereo file it and we would agree only on nonsense. Leave those.
      if (w.channels > 1) return { error: 'stereo adpcm, which scratch-vm cannot decode either' };
      const s = imaDecode(w.data, block);
      if (!s.length) return { error: 'adpcm wav decoded to nothing' };
      return { mono: await resample(Float32Array.from(s), w.rate, rate), rate: rate };
    }

    let buf;
    try {
      buf = await decodeAudioData(ctxAt(rate), bytes.slice().buffer);
    } catch (e) {
      return { error: 'the browser could not decode it' };
    }
    if (!buf.length) return { error: 'decoded to nothing' };
    const chans = [];
    for (let i = 0; i < buf.numberOfChannels; i++) chans.push(buf.getChannelData(i));
    return { mono: toMono(chans, buf.length), rate: rate };
  }

  /* --------------------------------------------------------------- encoding */

  const DELAY = 576;   // lame_get_encoder_delay(). A decoder skips this + 528 + 1.

  // Encoding runs about three times faster than the sound plays, so a three
  // minute track is a minute of blocked main thread. onTick hands the page back
  // every few hundred blocks, which is what stops that looking like a hang.
  async function encode(mono, rate, kbps, onTick) {
    const enc = new lamejs.Mp3Encoder(1, rate, kbps);
    const pcm = new Int16Array(mono.length);
    for (let i = 0; i < mono.length; i++) {
      const s = mono[i] < -1 ? -1 : mono[i] > 1 ? 1 : mono[i];
      pcm[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7FFF);
    }
    const parts = [];
    let total = 0, block = 0;
    for (let i = 0; i < pcm.length; i += 1152) {
      const b = enc.encodeBuffer(pcm.subarray(i, Math.min(i + 1152, pcm.length)));
      if (b.length) { parts.push(new Uint8Array(b)); total += b.length; }
      // roughly every six seconds of audio, so a short sound never ticks at all
      if (onTick && ++block % 256 === 0) await onTick(i / pcm.length);
    }
    const tail = enc.flush();
    if (tail.length) { parts.push(new Uint8Array(tail)); total += tail.length; }
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // The Info/LAME frame lamejs does not write. Without it every decoder plays
  // the encoder delay as silence and the sound comes out 1105 samples late.
  // Layout is the one ffmpeg reads in mp3_parse_vbr_tags: the magic sits after
  // the side info, and the delay and padding are a packed 24 bit field twelve
  // bytes past the nine byte version string.
  function tagFrame(mp3, samples) {
    const h = frameAt(mp3, 0);
    if (!h) return null;
    let p = 0, frames = 0;
    while (p + 4 <= mp3.length) {   // a tail too short to be a frame is not one
      const f = frameAt(mp3, p);
      if (!f) return null;
      frames++;
      p += f.len;
    }

    let padding = frames * h.spf - DELAY - samples;
    if (padding < 0) padding = 0;
    else if (padding > 0xFFF) padding = 0xFFF;

    const len = Math.floor((h.ver === 1 ? 144000 : 72000) * h.kbps / h.rate);
    const tag = new Uint8Array(len);
    tag[0] = mp3[0];
    tag[1] = mp3[1];
    tag[2] = mp3[2] & ~0x02;      // this frame carries no padding byte
    tag[3] = mp3[3];

    let o = 4 + h.side;
    const put = s => { for (let i = 0; i < s.length; i++) tag[o++] = s.charCodeAt(i); };
    const u32 = v => {
      tag[o++] = (v >>> 24) & 255; tag[o++] = (v >>> 16) & 255;
      tag[o++] = (v >>> 8) & 255; tag[o++] = v & 255;
    };

    put('Info');                  // constant bitrate, so Info rather than Xing
    u32(0x0007);                  // frame count, byte count, table of contents
    u32(frames);
    u32(len + mp3.length);
    for (let i = 0; i < 100; i++) tag[o++] = Math.min(255, Math.floor(i * 256 / 100));
    put('LAME3.98.');
    o += 12;                      // revision, lowpass, replay gain, flags, bitrate
    tag[o++] = DELAY >> 4;
    tag[o++] = ((DELAY & 0xF) << 4) | (padding >> 8);
    tag[o++] = padding & 0xFF;

    const out = new Uint8Array(len + mp3.length);
    out.set(tag, 0);
    out.set(mp3, len);
    return out;
  }

  /* ------------------------------------------------------------------ pass */

  const fileOf = a => a.md5ext || (a.assetId + '.' + a.dataFormat);

  async function convert(entry, kbps, onTick) {
    if (!entry) return { error: 'not in the archive' };
    let raw;
    try {
      raw = await SB3.readEntry(entry);
    } catch (e) {
      return { error: 'could not be decompressed' };
    }

    const d = await decode(raw);
    if (d.error) return { error: d.error };

    let mp3;
    try {
      mp3 = await encode(d.mono, d.rate, kbps, onTick);
    } catch (e) {
      return { error: 'could not be encoded' };
    }
    if (!mp3.length) return { error: 'encoded to nothing' };

    const tagged = tagFrame(mp3, d.mono.length);
    if (!tagged) return { error: 'encoded to something unreadable' };

    // What it costs in the archive either way. The source sits there deflated
    // and the mp3 will be stored, so these are the two real numbers.
    if (tagged.length >= entry.csize) {
      return { kept: true, why: 'mp3 would be ' + tagged.length + ' bytes against ' + entry.csize };
    }
    return {
      mp3: tagged, md5: RASTER.md5(tagged),
      rate: d.rate, samples: d.mono.length, was: entry.csize
    };
  }

  // Returns the function sb3shrink calls once the json has been verified. It is
  // handed the zip entries and the project and may change both.
  function pass(cfg) {
    cfg = cfg || {};
    const kbps = Math.max(8, Math.min(320, Math.round(Number(cfg.kbps) || 128)));

    return async function convertSounds(entries, project, say) {
      const report = {
        kbps: kbps, total: 0, converted: 0, assets: 0,
        bytesBefore: 0, bytesAfter: 0, kept: [], failed: []
      };
      if (typeof lamejs === 'undefined' || !lamejs.Mp3Encoder) {
        throw new Error('lame.min.js did not load, so sounds cannot be converted.');
      }
      // md5 lives in rasterize.js, the only other thing here that has to name an
      // asset the way Scratch names one
      if (typeof RASTER === 'undefined' || !RASTER.md5) {
        throw new Error('rasterize.js did not load, and its md5 is what names a new sound.');
      }

      const jobs = [];
      for (const t of project.targets) {
        for (const s of t.sounds) jobs.push({ target: t.name, sound: s });
      }
      report.total = jobs.length;
      if (!jobs.length) return report;

      const byName = new Map();
      for (const e of entries) byName.set(e.name, e);

      const done = new Map();  // one encode per asset, however many sounds share it

      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const s = job.sound;
        const name = fileOf(s);
        const where = 'Converting sound ' + (i + 1) + ' of ' + jobs.length;
        await say(where);

        let r = done.get(name);
        if (!r) {
          r = await convert(byName.get(name), kbps,
                            frac => say(where + ', ' + Math.round(frac * 100) + '%'));
          done.set(name, r);
        }

        if (r.kept) { report.kept.push({ target: job.target, name: s.name, why: r.why }); continue; }
        if (r.error) { report.failed.push({ target: job.target, name: s.name, why: r.error }); continue; }

        s.assetId = r.md5;
        s.dataFormat = 'mp3';
        // sounds have no md5ext fallback in scratch-vm, sb3.js reads it flat,
        // so this one is written rather than dropped the way a costume's is
        s.md5ext = r.md5 + '.mp3';
        // it was '' or 'adpcm', and it is neither now. scratch-parser does not
        // ask for the key and scratch-vm reaches adpcm through a decode failure
        // rather than through this field.
        delete s.format;
        s.rate = Math.round(r.rate);
        s.sampleCount = Math.round(r.samples);
        report.converted++;
      }

      // one entry per new asset. Two sounds can encode to the same mp3, and the
      // archive may already hold it, so a name must never be written twice.
      const stamp = byName.get('project.json');
      for (const r of done.values()) {
        if (!r.mp3) continue;
        report.bytesBefore += r.was;
        const name = r.md5 + '.mp3';
        if (byName.has(name)) continue;
        const entry = SB3.storedEntry(name, r.mp3, stamp);
        entries.push(entry);
        byName.set(name, entry);
        report.assets++;
        report.bytesAfter += r.mp3.length;
      }

      // drop the sources nothing points at any more. Only files this pass
      // touched are candidates, so the rest of the archive is left alone.
      const live = new Set();
      for (const t of project.targets) {
        for (const c of t.costumes) live.add(fileOf(c));
        for (const s of t.sounds) live.add(fileOf(s));
      }
      const dead = new Set();
      for (const name of done.keys()) if (!live.has(name)) dead.add(name);
      for (let i = entries.length - 1; i >= 0; i--) {
        if (dead.has(entries[i].name)) entries.splice(i, 1);
      }

      return report;
    };
  }

  return { pass, decode, encode, tagFrame, imaDecode, wavFormat, nearestRate };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SOUND;
