/*
 * lib/muxer.js — 自包含的 fMP4 → MP4 重封装器（无任何外部依赖）
 * --------------------------------------------------------------
 * B站 DASH 视频/音频流是"分片 MP4"(fragmented MP4)：ftyp + moov + (moof+mdat)*N。
 * 本模块解析这些分片，把视频轨道与音频轨道重封装为单个可播放的 MP4 文件：
 *   ftyp + moov(含视频/音频两个 trak) + mdat(交错存放样本)
 *
 * 暴露 API：
 *   BDGMuxer.mergeToMp4(videoArrayBuffer, audioArrayBuffer?) -> ArrayBuffer
 *   BDGMuxer.isFragmented(arrayBuffer) -> boolean
 *
 * 纯二进制操作，运行在 content script 隔离世界，符合 MV3 CSP。
 */
(function (global) {
  'use strict';

  function type4(s) {
    return ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
  }

  function asU8(input) {
    if (input instanceof Uint8Array) {
      if (input.byteOffset === 0 && input.byteLength === input.buffer.byteLength) return input;
      // 注意：不能用 input.slice()，因为 Node Buffer 的 slice 是共享内存视图
      const out = new Uint8Array(input.byteLength);
      out.set(input);
      return out;
    }
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    throw new Error('muxer: 不支持的输入类型');
  }

  /* ---------------- box 遍历 ---------------- */

  function* boxes(u8, start, end) {
    let off = start;
    const dv = new DataView(u8.buffer);
    while (off + 8 <= end) {
      const size32 = dv.getUint32(off);
      let size = size32;
      let header = 8;
      const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
      if (size === 1) {
        if (off + 16 > end) break;
        const hi = dv.getUint32(off + 8);
        const lo = dv.getUint32(off + 12);
        size = hi * 0x100000000 + lo;
        header = 16;
      } else if (size === 0) {
        size = end - off;
      }
      if (size < header || off + size > end) break;
      yield { type: type, start: off, end: off + size, header: header };
      off += size;
    }
  }

  function childBoxes(u8, parent) {
    const out = [];
    for (const b of boxes(u8, parent.start + parent.header, parent.end)) out.push(b);
    return out;
  }

  function findChild(u8, parent, type) {
    for (const b of childBoxes(u8, parent)) if (b.type === type) return b;
    return null;
  }

  /* ---------------- 解析（读取） ---------------- */

  function parseTkhd(u8, tkhd) {
    const dv = new DataView(u8.buffer);
    const fb = tkhd.start + tkhd.header;
    const version = u8[fb];
    let o = fb + 4; // version + flags
    if (version === 1) o += 16; else o += 8; // creation + modification
    const trackId = dv.getUint32(o); o += 4;
    o += 4; // reserved
    if (version === 1) o += 8; else o += 4; // duration
    o += 8; // reserved
    o += 2; // layer
    o += 2; // alternate_group
    const volume = dv.getUint16(o); o += 2;
    o += 2; // reserved
    o += 36; // matrix
    const width = dv.getUint32(o); o += 4;
    const height = dv.getUint32(o);
    return { trackId: trackId, volume: volume, width: width, height: height };
  }

  function parseMdhd(u8, mdhd) {
    const dv = new DataView(u8.buffer);
    const fb = mdhd.start + mdhd.header;
    const version = u8[fb];
    let o = fb + 4;
    if (version === 1) o += 16; else o += 8;
    const timescale = dv.getUint32(o); o += 4;
    const duration = version === 1 ? Number(dv.getBigUint64(o)) : dv.getUint32(o);
    return { timescale: timescale, duration: duration };
  }

  function parseHdlrType(u8, hdlr) {
    const fb = hdlr.start + hdlr.header;
    return String.fromCharCode(u8[fb + 8], u8[fb + 9], u8[fb + 10], u8[fb + 11]);
  }

  function parseStsdEntry(u8, stsd) {
    const dv = new DataView(u8.buffer);
    const fb = stsd.start + stsd.header;
    const entryCount = dv.getUint32(fb + 4);
    if (entryCount < 1) throw new Error('muxer: stsd 中没有样本描述');
    for (const b of boxes(u8, fb + 8, stsd.end)) {
      return u8.subarray(b.start, b.end);
    }
    throw new Error('muxer: stsd 解析失败');
  }

  function parseTrack(u8, trak) {
    const tkhd = findChild(u8, trak, 'tkhd');
    const mdia = findChild(u8, trak, 'mdia');
    const mdhd = findChild(u8, mdia, 'mdhd');
    const hdlr = findChild(u8, mdia, 'hdlr');
    const minf = findChild(u8, mdia, 'minf');
    const stbl = findChild(u8, minf, 'stbl');
    const stsd = findChild(u8, stbl, 'stsd');
    if (!tkhd || !mdhd || !hdlr || !stsd) throw new Error('muxer: trak 结构不完整');
    const t = parseTkhd(u8, tkhd);
    const m = parseMdhd(u8, mdhd);
    return {
      id: t.trackId,
      handler: parseHdlrType(u8, hdlr),
      timescale: m.timescale,
      duration: m.duration,
      volume: t.volume,
      width: t.width,
      height: t.height,
      hdlr: u8.slice(hdlr.start, hdlr.end),
      sampleEntry: parseStsdEntry(u8, stsd),
      samples: []
    };
  }

  function parseMoof(u8, moof, top, moofIndex) {
    const dv = new DataView(u8.buffer);
    const trafs = childBoxes(u8, moof).filter(function (b) { return b.type === 'traf'; });
    const mdats = [];
    for (let i = moofIndex + 1; i < top.length; i++) {
      if (top[i].type === 'mdat') mdats.push(top[i]);
    }
    const out = { trackId: null, samples: [] };
    for (const traf of trafs) {
      const tfhd = findChild(u8, traf, 'tfhd');
      const tfdt = findChild(u8, traf, 'tfdt');
      const truns = childBoxes(u8, traf).filter(function (b) { return b.type === 'trun'; });
      if (!tfhd || !truns.length) continue;
      const tfFlags = dv.getUint32(tfhd.start + tfhd.header);       // version+flags 紧跟在 8 字节头之后
      const tId = dv.getUint32(tfhd.start + tfhd.header + 4);       // track_ID
      out.trackId = tId;
      let base;
      if (tfFlags & 0x000001) {
        base = Number(dv.getBigUint64(tfhd.start + tfhd.header + 8));
      } else {
        base = moof.start; // default-base-is-moof / 默认
      }
      let defaultDuration = 0, defaultSize = 0, defaultFlags = 0;
      let o = tfhd.start + tfhd.header + 8;
      if (tfFlags & 0x000002) o += 4; // sample_description_index
      if (tfFlags & 0x000008) { defaultDuration = dv.getUint32(o); o += 4; }
      if (tfFlags & 0x000010) { defaultSize = dv.getUint32(o); o += 4; }
      if (tfFlags & 0x000020) { defaultFlags = dv.getUint32(o); o += 4; }
      let baseDts = 0;
      if (tfdt) {
        const ver = u8[tfdt.start + tfdt.header];
        baseDts = ver === 1 ? Number(dv.getBigUint64(tfdt.start + tfdt.header + 4)) : dv.getUint32(tfdt.start + tfdt.header + 4);
      }
      let dts = baseDts;
      const mdatPayload = mdats.length ? mdats[0].start + mdats[0].header : 0;
      for (const trun of truns) {
        const trFlags = dv.getUint32(trun.start + trun.header);       // +8 version+flags
        const count = dv.getUint32(trun.start + trun.header + 4);     // +12 sample_count
        let to = trun.start + trun.header + 8;                        // +16 data_offset 起点
        let dataOffset = null;
        if (trFlags & 0x000001) { dataOffset = dv.getInt32(to); to += 4; }
        let firstFlags = defaultFlags;
        if (trFlags & 0x000004) { firstFlags = dv.getUint32(to); to += 4; }
        let sampleDataStart = null;
        if (dataOffset !== null) sampleDataStart = base + dataOffset;
        let fallbackOffset = mdatPayload;
        let runTotal = 0;
        for (let s = 0; s < count; s++) {
          let dur = defaultDuration, size = defaultSize, perFlags = defaultFlags, cto = 0;
          if (trFlags & 0x000100) { dur = dv.getUint32(to); to += 4; }
          if (trFlags & 0x000200) { size = dv.getUint32(to); to += 4; }
          if (trFlags & 0x000400) { perFlags = dv.getUint32(to); to += 4; }
          if (trFlags & 0x000800) { cto = dv.getInt32(to); to += 4; }
          const flags = (s === 0 && (trFlags & 0x000004)) ? firstFlags : perFlags;
          let abs;
          if (sampleDataStart !== null) { abs = sampleDataStart; sampleDataStart += size; }
          else { abs = fallbackOffset; }
          runTotal += size;
          out.samples.push({
            dts: dts,
            cts: dts + cto,
            duration: dur,
            size: size,
            flags: flags >>> 0,
            isSync: (flags & 0x00010000) === 0,
            dataStart: abs
          });
          dts += dur;
        }
        if (sampleDataStart === null) fallbackOffset += runTotal;
      }
    }
    return out;
  }

  function parseFmp4(input) {
    const u8 = asU8(input);
    const top = [];
    for (const b of boxes(u8, 0, u8.length)) top.push(b);
    const ftypBox = null;
    const ftyp = top.find(function (b) { return b.type === 'ftyp'; }) || top[0];
    const moov = top.find(function (b) { return b.type === 'moov'; });
    if (!moov) throw new Error('muxer: 未找到 moov，不是合法的 MP4');
    const tracks = childBoxes(u8, moov)
      .filter(function (b) { return b.type === 'trak'; })
      .map(function (t) { return parseTrack(u8, t); });
    for (let i = 0; i < top.length; i++) {
      const b = top[i];
      if (b.type !== 'moof') continue;
      const frag = parseMoof(u8, b, top, i);
      if (frag.trackId) {
        const tr = tracks.find(function (t) { return t.id === frag.trackId; });
        if (tr) tr.samples = tr.samples.concat(frag.samples);
      }
    }
    return { u8: u8, ftyp: u8.slice(ftyp.start, ftyp.end), tracks: tracks };
  }

  /* ---------------- 写出（构建） ---------------- */

  class Buf {
    constructor() { this.parts = []; this.len = 0; }
    u8(v) { const p = new Uint8Array(1); p[0] = v & 0xff; this.parts.push(p); this.len++; return this; }
    u16(v) { const p = new Uint8Array(2); new DataView(p.buffer).setUint16(0, v); this.parts.push(p); this.len += 2; return this; }
    u24(v) { const p = new Uint8Array(3); p[0] = (v >>> 16) & 0xff; p[1] = (v >>> 8) & 0xff; p[2] = v & 0xff; this.parts.push(p); this.len += 3; return this; }
    u32(v) { const p = new Uint8Array(4); new DataView(p.buffer).setUint32(0, v >>> 0); this.parts.push(p); this.len += 4; return this; }
    i32(v) { const p = new Uint8Array(4); new DataView(p.buffer).setInt32(0, v); this.parts.push(p); this.len += 4; return this; }
    raw(u) { this.parts.push(u); this.len += u.length; return this; }
    result() {
      const out = new Uint8Array(this.len);
      let o = 0;
      for (const p of this.parts) { out.set(p, o); o += p.length; }
      return out;
    }
  }

  function concat(list) {
    const b = new Buf();
    for (const x of list) b.raw(x);
    return b.result();
  }

  function makeBox(type, body) {
    const out = new Buf();
    out.u32(body.length + 8);
    out.u32(type4(type));
    out.raw(body);
    return out.result();
  }

  function fullBox(type, body) {
    return makeBox(type, body);
  }

  function bMvhd(duration) {
    const b = new Buf();
    b.u8(0); b.u24(0);
    b.u32(0); b.u32(0);       // creation, modification
    b.u32(1000);              // timescale
    b.u32(duration);          // duration
    b.u32(0x00010000);        // rate 1.0
    b.u16(0x0100);            // volume
    b.raw(new Uint8Array(10)); // reserved
    b.u32(0x00010000); b.u32(0); b.u32(0);
    b.u32(0); b.u32(0x00010000); b.u32(0);
    b.u32(0); b.u32(0); b.u32(0x40000000); // matrix
    b.raw(new Uint8Array(24)); // pre_defined
    b.u32(3);                 // next_track_ID
    return fullBox('mvhd', b.result());
  }

  function bTkhd(trackId, duration, width, height, volume, isAudio) {
    const b = new Buf();
    b.u8(0); b.u24(0x7);      // flags: enabled + in_movie + in_preview
    b.u32(0); b.u32(0);       // creation, modification
    b.u32(trackId);
    b.u32(0);                 // reserved
    b.u32(duration);
    b.raw(new Uint8Array(8)); // reserved
    b.u16(0); b.u16(0);       // layer, alternate_group
    b.u16(isAudio ? 0x0100 : (volume || 0)); // volume
    b.u16(0);                 // reserved
    b.u32(0x00010000); b.u32(0); b.u32(0);
    b.u32(0); b.u32(0x00010000); b.u32(0);
    b.u32(0); b.u32(0); b.u32(0x40000000); // matrix
    b.u32(width || 0);
    b.u32(height || 0);
    return fullBox('tkhd', b.result());
  }

  function bMdhd(timescale, duration) {
    const b = new Buf();
    b.u8(0); b.u24(0);
    b.u32(0); b.u32(0);       // creation, modification
    b.u32(timescale);
    b.u32(duration);
    b.u16(0x55c4);            // language 'und'
    b.u16(0);                 // pre_defined
    return fullBox('mdhd', b.result());
  }

  function bVmhd() {
    const b = new Buf();
    b.u8(0); b.u24(1);        // graphicsmode=copy
    b.u16(0);
    b.raw(new Uint8Array(6)); // opcolor
    return fullBox('vmhd', b.result());
  }

  function bSmhd() {
    const b = new Buf();
    b.u8(0); b.u24(0);
    b.u16(0);                 // balance
    b.u16(0);                 // reserved
    return fullBox('smhd', b.result());
  }

  function bDinf() {
    const urlBox = makeBox('url ', (function () {
      const b = new Buf(); b.u8(0); b.u24(1); return b.result();
    })());
    const dref = fullBox('dref', (function () {
      const b = new Buf(); b.u32(1); b.raw(urlBox); return b.result();
    })());
    return makeBox('dinf', dref);
  }

  function bStsd(sampleEntry) {
    const b = new Buf();
    b.u32(0);                 // version + flags
    b.u32(1);                 // entry_count
    b.raw(sampleEntry);
    return fullBox('stsd', b.result());
  }

  function bStts(samples) {
    const runs = [];
    for (const s of samples) {
      const last = runs[runs.length - 1];
      if (last && last.d === s.duration) last.c++;
      else runs.push({ d: s.duration, c: 1 });
    }
    const b = new Buf();
    b.u32(0);
    b.u32(runs.length);
    for (const r of runs) { b.u32(r.c); b.u32(r.d); }
    return fullBox('stts', b.result());
  }

  function bCtts(samples) {
    const runs = [];
    for (const s of samples) {
      const cto = s.cts - s.dts;
      const last = runs[runs.length - 1];
      if (last && last.o === cto) last.c++;
      else runs.push({ o: cto, c: 1 });
    }
    if (runs.length === 1 && runs[0].o === 0) return null;
    const b = new Buf();
    b.u8(0); b.u24(0);
    b.u32(runs.length);
    for (const r of runs) { b.u32(r.c); b.i32(r.o); }
    return fullBox('ctts', b.result());
  }

  function bStss(samples) {
    const nums = [];
    for (let i = 0; i < samples.length; i++) if (samples[i].isSync) nums.push(i + 1);
    if (nums.length === samples.length || nums.length === 0) return null;
    const b = new Buf();
    b.u32(0);
    b.u32(nums.length);
    for (const n of nums) b.u32(n);
    return fullBox('stss', b.result());
  }

  function bStsc() {
    const b = new Buf();
    b.u32(0);
    b.u32(1); // entry_count
    b.u32(1); // first_chunk
    b.u32(1); // samples_per_chunk
    b.u32(1); // sample_description_index
    return fullBox('stsc', b.result());
  }

  function bStsz(samples) {
    const b = new Buf();
    b.u32(0);
    b.u32(0); // sample_size = 0 (每个样本单独)
    b.u32(samples.length);
    for (const s of samples) b.u32(s.size);
    return fullBox('stsz', b.result());
  }

  function bStco(offsets) {
    const b = new Buf();
    b.u32(0);
    b.u32(offsets.length);
    for (const o of offsets) b.u32(o);
    return fullBox('stco', b.result());
  }

  function bEdtsEmpty(delay) {
    const elst = (function () {
      const b = new Buf();
      b.u8(0); b.u24(0);
      b.u32(1);               // entry_count
      b.u32(delay);           // segment_duration (movie timescale)
      b.i32(-1);              // media_time = -1 → 空编辑(延迟)
      b.u16(1); b.u16(0);     // media_rate
      return fullBox('elst', b.result());
    })();
    return makeBox('edts', elst);
  }

  function bStbl(samples, sampleEntry, isVideo) {
    const parts = [bStsd(sampleEntry), bStts(samples)];
    const ctts = bCtts(samples);
    if (ctts) parts.push(ctts);
    const stss = isVideo ? bStss(samples) : null;
    if (stss) parts.push(stss);
    parts.push(bStsc(), bStsz(samples), bStco(samples.map(function (s) { return s.offset; })));
    return makeBox('stbl', concat(parts));
  }

  function bMinf(track) {
    const parts = [];
    if (track.handler === 'vide') parts.push(bVmhd());
    else if (track.handler === 'soun') parts.push(bSmhd());
    parts.push(bDinf());
    parts.push(bStbl(track.samples, track.sampleEntry, track.handler === 'vide'));
    return makeBox('minf', concat(parts));
  }

  function bMdia(track) {
    const parts = [bMdhd(track.timescale, track.duration), track.hdlr, bMinf(track)];
    return makeBox('mdia', concat(parts));
  }

  function bTrak(track, trackId, offsets) {
    track.samples.forEach(function (s, i) { s.offset = offsets[i]; });
    const parts = [bTkhd(trackId, track.tkhdDuration, track.width, track.height, track.volume, track.handler === 'soun')];
    if (track.delay > 0) parts.push(bEdtsEmpty(track.delay));
    parts.push(bMdia(track));
    return makeBox('trak', concat(parts));
  }

  function bMoov(tracks, offsetsList) {
    const parts = [bMvhd(Math.max.apply(null, tracks.map(function (t) { return t.tkhdDuration; })))];
    tracks.forEach(function (t, i) { parts.push(bTrak(t, i + 1, offsetsList[i])); });
    return makeBox('moov', concat(parts));
  }

  /* ---------------- 轨道准备 ---------------- */

  function prepareTrack(parsed, sourceU8) {
    const samples = parsed.samples.map(function (s) { return Object.assign({}, s); });
    if (!samples.length) throw new Error('muxer: 轨道没有样本');
    const ts = parsed.timescale || 1;
    const shift = samples[0].dts;
    for (const s of samples) { s.dts -= shift; s.cts -= shift; }
    const firstCts = samples[0].cts / ts;
    const duration = samples.reduce(function (a, s) { return a + s.duration; }, 0);
    return {
      handler: parsed.handler,
      timescale: ts,
      volume: parsed.volume,
      width: parsed.width,
      height: parsed.height,
      hdlr: parsed.hdlr,
      sampleEntry: parsed.sampleEntry,
      samples: samples,
      source: sourceU8,
      firstCts: firstCts,
      duration: duration,
      delay: 0,
      tkhdDuration: Math.round(duration / ts * 1000)
    };
  }

  /* ---------------- 对外主函数 ---------------- */

  function mergeToMp4(videoInput, audioInput) {
    const v = parseFmp4(videoInput);
    const a = audioInput ? parseFmp4(audioInput) : null;
    const vp = v.tracks.find(function (t) { return t.handler === 'vide'; }) || v.tracks[0];
    let ap = null;
    if (a) ap = a.tracks.find(function (t) { return t.handler === 'soun'; }) || a.tracks[0];
    if (!vp || !vp.samples || !vp.samples.length) throw new Error('muxer: 视频轨道为空或不是分片MP4');
    if (ap && (!ap.samples || !ap.samples.length)) throw new Error('muxer: 音频轨道为空');

    const tracks = [prepareTrack(vp, v.u8)];
    if (ap) tracks.push(prepareTrack(ap, a.u8));

    // 音视频起始时间对齐（按需要插入空 edit list 延迟）
    const globalStart = Math.min.apply(null, tracks.map(function (t) { return t.firstCts; }));
    for (const t of tracks) {
      t.delay = Math.round((t.firstCts - globalStart) * 1000);
      if (t.delay < 2) t.delay = 0;
      t.samples.forEach(function (s) { s.data = t.source.subarray(s.dataStart, s.dataStart + s.size); });
    }

    // 第一遍：用占位偏移构建 moov，得到其真实大小
    const dummy = tracks.map(function (t) { return t.samples.map(function () { return 0; }); });
    const moov1 = bMoov(tracks, dummy);

    const ftyp = v.ftyp;
    const headerSize = ftyp.length + moov1.length;

    // 布局：交错存放样本，计算每个样本在输出文件中的绝对偏移
    let cursor = headerSize + 8;
    const offsets = tracks.map(function () { return []; });
    const interleaved = [];
    const maxN = Math.max.apply(null, tracks.map(function (t) { return t.samples.length; }));
    for (let i = 0; i < maxN; i++) {
      for (let ti = 0; ti < tracks.length; ti++) {
        const s = tracks[ti].samples[i];
        if (!s) continue;
        offsets[ti].push(cursor);
        interleaved.push(s.data);
        cursor += s.size;
      }
    }
    const mdatSize = cursor - (headerSize + 8);
    if (mdatSize > 0xffffffff - 8) throw new Error('muxer: 文件超过 4GB，无法合并');

    // 第二遍：用真实偏移重建 moov（尺寸必须与第一遍一致）
    const moov2 = bMoov(tracks, offsets);
    if (moov2.length !== moov1.length) throw new Error('muxer: 内部布局不一致');

    const out = new Buf();
    out.raw(ftyp);
    out.raw(moov2);
    const mh = new Uint8Array(8);
    new DataView(mh.buffer).setUint32(0, mdatSize + 8);
    new DataView(mh.buffer).setUint32(4, type4('mdat'));
    out.raw(mh);
    for (const d of interleaved) out.raw(d);
    return out.result();
  }

  function isFragmented(input) {
    try {
      const u8 = asU8(input);
      let hasMoov = false;
      for (const b of boxes(u8, 0, u8.length)) {
        if (b.type === 'moof') return true;
        if (b.type === 'moov') hasMoov = true;
      }
      return false;
    } catch (e) { /* ignore */ }
    return false;
  }

  const api = { mergeToMp4: mergeToMp4, isFragmented: isFragmented };
  global.BDGMuxer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
