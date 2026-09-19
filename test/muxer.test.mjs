/*
 * test/muxer.test.mjs — 对 lib/muxer.js 的结构化自测
 * 用代码构造"合成 fMP4"（视频+音频两个分片流），走完整的 解析→合并→写出 流程，
 * 再用独立解析器校验输出 MP4 的盒结构、样本偏移、时长、关键帧与样本数据一致性。
 * 运行：node test/muxer.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'muxer.js'), 'utf8');
const testWindow = {};
const fn = new Function('window', src);
fn(testWindow);
const { mergeToMp4, isFragmented } = testWindow.BDGMuxer;

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ FAIL: ' + msg); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

/* ---------------- 通用盒构建工具 ---------------- */
function box(type, ...parts) {
  const body = Buffer.concat(parts.map(p => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const h = Buffer.alloc(8);
  h.writeUInt32BE(body.length + 8, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
}
function full(version, flags) {
  const b = Buffer.alloc(4);
  b.writeUInt8(version, 0);
  b.writeUIntBE(flags, 1, 3);
  return b;
}
function u32(...vals) { return Buffer.from(vals.flatMap(v => [v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff])); }
function u16(...vals) { return Buffer.from(vals.flatMap(v => [v >>> 8, v & 0xff])); }
function u8arr(...vals) { return Buffer.from(vals); }
function zeros(n) { return Buffer.alloc(n); }

/* ---------------- 合成样本数据 ---------------- */
function makeVideoSamples() {
  // 10 个样本：第1个为关键帧(flags=0)，其余非同步(flags=0x00010000)；带 cto 偏移
  const list = [];
  let dts = 0;
  for (let i = 0; i < 10; i++) {
    const size = 120 + i * 10;
    const data = Buffer.alloc(size, 0x10 + i); // 每个样本内容可辨识
    const cto = (i % 3 === 0) ? 0 : (i % 3 === 1 ? 45 : 90); // 90000ts 的偏移
    const flags = i === 0 ? 0 : 0x00010000;
    list.push({ data, size, dur: 3000, dts, cts: dts + cto, cto, flags });
    dts += 3000;
  }
  return list;
}
function makeAudioSamples() {
  const list = [];
  let dts = 0;
  for (let i = 0; i < 14; i++) { // 音频样本更多（时长更短）
    const size = 90 + i * 5;
    const data = Buffer.alloc(size, 0x50 + i);
    list.push({ data, size, dur: 1024, dts, cts: dts, cto: 0, flags: 0 });
    dts += 1024;
  }
  return list;
}

/* ---------------- 构造 fMP4 文件 ---------------- */
function buildSampleEntryVideo() {
  const avcC = box('avcC', u8arr(1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x05, 0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50, 0x05, 0xbb, 0x01, 0x00, 0x04, 0x68, 0xee, 0x3c, 0x80));
  const b = Buffer.concat([
    zeros(6), u16(1),           // reserved(6) + data_reference_index
    u16(0), u16(0), zeros(12),  // pre_defined...
    u16(1920), u16(1080),       // width/height (16bit)
    u32(0x00480000), u32(0x00480000), // resolution
    u32(0), u16(1),             // reserved + frame_count
    Buffer.alloc(32),           // compressorname
    u16(24), u16(0xffff),       // depth + pre_defined
    avcC
  ]);
  return box('avc1', b);
}
function buildSampleEntryAudio() {
  const esdsBody = Buffer.concat([
    u8arr(0x03, 0x19, 0x00, 0x00, 0x00, 0x04, 0x11, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x02, 0x12, 0x10, 0x06, 0x01, 0x02),
    u8arr(0x04, 0x02, 0x40, 0x15, 0x05, 0x02, 0x12, 0x10, 0x06, 0x01, 0x02),
    u8arr(0x05, 0x02, 0x12, 0x10, 0x06, 0x01, 0x02)
  ]);
  const b = Buffer.concat([
    zeros(6), u16(1),
    u16(2), u16(16), u32(0), u32(0), u16(2), // channelcount/samplesize/etc
    box('esds', esdsBody)
  ]);
  return box('mp4a', b);
}

function buildFmp4({ isVideo, samples, timescale, duration, firstDtsOffset, trex }) {
  // trex 模式：trun 不写每样本时长/标志，由 moov/mvex/trex 的默认值兜底（B站视频流实际结构）
  const trexMode = !!(trex && trex.duration);
  const ctoBytes = (s) => Buffer.from((s.cto | 0).toString(16).padStart(8, '0').match(/../g).map(h => parseInt(h, 16)));
  const ftyp = box('ftyp', Buffer.from('isom'), u32(0x200), Buffer.from('isomiso2avc1mp41'));
  const sampleEntry = isVideo ? buildSampleEntryVideo() : buildSampleEntryAudio();
  const stbl = box('stbl',
    (() => { const b = Buffer.concat([full(0, 0), u32(1), sampleEntry]); return box('stsd', b); })(),
    (() => { const b = Buffer.concat([full(0, 0), u32(0)]); return box('stts', b); })(),
    (() => { const b = Buffer.concat([full(0, 0), u32(0)]); return box('stsc', b); })()
  );
  const mdhd = (() => {
    const b = Buffer.concat([full(0, 0), u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0)]);
    return box('mdhd', b);
  })();
  const hdlr = box('hdlr', Buffer.concat([full(0, 0), u32(0), Buffer.from(isVideo ? 'vide' : 'soun'), zeros(12)]));
  const minf = box('minf', isVideo
    ? Buffer.concat([box('vmhd', Buffer.concat([full(0, 1), u16(0), zeros(6)])), box('dinf', box('dref', Buffer.concat([full(0, 0), u32(1), box('url ', Buffer.concat([full(0, 1)]))]))), stbl])
    : Buffer.concat([box('smhd', Buffer.concat([full(0, 0), u16(0), u16(0)])), box('dinf', box('dref', Buffer.concat([full(0, 0), u32(1), box('url ', Buffer.concat([full(0, 1)]))]))), stbl]));
  const mdia = box('mdia', Buffer.concat([mdhd, hdlr, minf]));
  const tkhd = (() => {
    const b = Buffer.concat([full(0, 0x7), u32(0), u32(0), u32(isVideo ? 1 : 2), u32(0), u32(duration), zeros(8), u16(0), u16(0), u16(0x0100), u16(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000), u32(isVideo ? (1920 << 16) : 0), u32(isVideo ? (1080 << 16) : 0)]);
    return box('tkhd', b);
  })();
  const trak = box('trak', Buffer.concat([tkhd, mdia]));
  const mvhd = (() => {
    const b = Buffer.concat([full(0, 0), u32(0), u32(0), u32(1000), u32(duration), u32(0x00010000), u16(0x0100), zeros(10), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000), zeros(24), u32(3)]);
    return box('mvhd', b);
  })();
  const trexDef = trex || { duration: 0, size: 0, flags: 0 };
  const trexBox = (() => {
    const b = Buffer.concat([full(0, 0), u32(isVideo ? 1 : 2), u32(1), u32(trexDef.duration), u32(trexDef.size), u32(trexDef.flags)]);
    return box('trex', b);
  })();
  const moov = box('moov', Buffer.concat([mvhd, trak, box('mvex', trexBox)]));

  // 分片：每片 2~3 个样本，mdat 紧跟在 moof 后
  const frags = [];
  let idx = 0;
  let baseDts = firstDtsOffset || 0;
  while (idx < samples.length) {
    const n = Math.min(3, samples.length - idx);
    const slice = samples.slice(idx, idx + n);
    idx += n;
    const mfhd = (() => { const b = Buffer.concat([full(0, 0), u32(frags.length + 1)]); return box('mfhd', b); })();
    const tfhdFlags = 0x010000; // default-base-is-moof
    const tfhd = (() => {
      const b = Buffer.concat([full(0, tfhdFlags), u32(isVideo ? 1 : 2)]);
      return box('tfhd', b);
    })();
    const tfdt = (() => { const b = Buffer.concat([full(0, 0), u32(baseDts)]); return box('tfdt', b); })();
    let trunFlags, trunBody;
    if (trexMode) {
      // 真实 B站视频流：trun 只有 data_offset + first_sample_flags + size + cto，时长走 trex 默认
      trunFlags = 0x000001 | 0x000004 | 0x000200 | 0x000800;
      trunBody = Buffer.concat([
        full(0, trunFlags), u32(n), u32(96 + n * 8), u32(0), // first_sample_flags=0 → 首样本同步
        ...slice.flatMap(s => [u32(s.size), ctoBytes(s)])
      ]);
    } else {
      trunFlags = 0x000001 | 0x000100 | 0x000200 | 0x000400 | 0x000800;
      trunBody = Buffer.concat([
        full(0, trunFlags), u32(n), u32(92 + n * 16), // data_offset = moof大小(84+16n) + mdat头(8)
        ...slice.flatMap(s => [u32(s.dur), u32(s.size), u32(s.flags), ctoBytes(s)])
      ]);
    }
    const trun = box('trun', trunBody);
    const traf = box('traf', Buffer.concat([tfhd, tfdt, trun]));
    const moof = box('moof', Buffer.concat([mfhd, traf]));
    const mdatPayload = Buffer.concat(slice.map(s => s.data));
    const mdat = box('mdat', mdatPayload);
    frags.push(Buffer.concat([moof, mdat]));
    baseDts += slice.reduce((a, s) => a + s.dur, 0);
  }
  return Buffer.concat([ftyp, moov, ...frags]);
}

/* ================= 开始测试 ================= */

section('isFragmented');
{
  const vSamples = makeVideoSamples();
  const vFile = buildFmp4({ isVideo: true, samples: vSamples, timescale: 90000, duration: 30000 });
  assert(isFragmented(vFile) === true, '分片MP4应判定为 true');
  const nonFrag = box('ftyp', Buffer.from('isom'), u32(0x200)) ;
  const fake = Buffer.concat([nonFrag, box('moov', u8arr(0))]);
  assert(isFragmented(fake) === false, '普通MP4应判定为 false');
}

section('合并 视频+音频 -> MP4');
let merged = null;
{
  const vSamples = makeVideoSamples();
  const aSamples = makeAudioSamples();
  const vFile = buildFmp4({ isVideo: true, samples: vSamples, timescale: 90000, duration: 30000 });
  const aFile = buildFmp4({ isVideo: false, samples: aSamples, timescale: 48000, duration: 14336 });
  merged = mergeToMp4(vFile, aFile);
  assert(merged instanceof Uint8Array && merged.length > 100, '输出非空');
  assert(merged[4] === 0x66 && merged[5] === 0x74 && merged[6] === 0x79 && merged[7] === 0x70, '输出以 ftyp 开头');
}

section('输出结构校验');
{
  const u8 = merged;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  function readBoxes(start, end) {
    const out = [];
    let off = start;
    while (off + 8 <= end) {
      const size = dv.getUint32(off);
      const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
      if (size < 8 || off + size > end) break;
      out.push({ type, start: off, end: off + size });
      off += size;
    }
    return out;
  }
  const find = (list, type) => list.find(b => b.type === type);

  const topBoxes = readBoxes(0, u8.length);
  assert(topBoxes.map(b => b.type).join(',') === 'ftyp,moov,mdat', '顶层应为 ftyp,moov,mdat，实际: ' + topBoxes.map(b => b.type).join(','));

  // ftyp 品牌：应为标准 MP4 品牌，不得携带 dash/msix/dsms 等分片流媒体品牌（Windows 播放器拒播原因）
  const ftypBrands = [];
  for (let i = 8; i < Math.min(36, u8.length); i += 4) ftypBrands.push(String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3]));
  assert(ftypBrands[0] === 'isom', 'ftyp major_brand 应为 isom，实际 ' + JSON.stringify(ftypBrands[0]));
  assert(!ftypBrands.some(b => ['dash', 'msix', 'dsms', 'iso5'].includes(b)), 'ftyp 不应含分片流媒体品牌，实际 ' + ftypBrands.join(','));

  const moov = find(topBoxes, 'moov');
  const mdat = find(topBoxes, 'mdat');
  const children = readBoxes(moov.start + 8, moov.end);
  const traks = children.filter(c => c.type === 'trak');
  assert(children[0].type === 'mvhd', 'moov 首子盒为 mvhd');
  assert(traks.length === 2, '应有 2 个 trak，实际: ' + traks.length);

  // mvhd v0: [头8][v/f4][creation4][modification4][timescale4] → timescale at +20
  const mvhdTs = dv.getUint32(children[0].start + 20);
  assert(mvhdTs === 1000, 'mvhd timescale 应为 1000，实际 ' + mvhdTs);

  const expected = [
    { id: 1, handler: 'vide', ts: 90000, count: 10, durSum: 30000, entry: 'avc1' },
    { id: 2, handler: 'soun', ts: 48000, count: 14, durSum: 14336, entry: 'mp4a' }
  ];
  const trackSizes = [];
  const trackOffsets = [];
  for (let ti = 0; ti < traks.length; ti++) {
    const t = traks[ti];
    const exp = expected[ti];
    const tChildren = readBoxes(t.start + 8, t.end);
    const tkhd = find(tChildren, 'tkhd');
    const mdia = find(tChildren, 'mdia');
    assert(tkhd && mdia, 'trak 含 tkhd/mdia');
    // tkhd v0: [头8][v/f4][creation4][modification4][track_id4] → track_id at +20
    const trackId = dv.getUint32(tkhd.start + 20);
    assert(trackId === exp.id, `tkhd track_id 应为 ${exp.id}，实际 ${trackId}`);

    const mChildren = readBoxes(mdia.start + 8, mdia.end);
    const mdhd = find(mChildren, 'mdhd');
    const hdlr = find(mChildren, 'hdlr');
    const minf = find(mChildren, 'minf');
    // mdhd v0: timescale at +20, duration at +24
    const mdTs = dv.getUint32(mdhd.start + 20);
    const mdDur = dv.getUint32(mdhd.start + 24);
    assert(mdTs === exp.ts, `mdhd timescale 应为 ${exp.ts}，实际 ${mdTs}`);
    assert(mdDur === exp.durSum, `mdhd duration 应为 ${exp.durSum}，实际 ${mdDur}`);
    // hdlr: [头8][v/f4][pre_defined4][handler_type4] → handler_type at +16
    const hType = String.fromCharCode(u8[hdlr.start + 16], u8[hdlr.start + 17], u8[hdlr.start + 18], u8[hdlr.start + 19]);
    assert(hType === exp.handler, `hdlr 类型应为 ${exp.handler}，实际 ${hType}`);

    const sChildren = readBoxes(minf.start + 8, minf.end);
    const stbl = find(sChildren, 'stbl');
    const stblBoxes = readBoxes(stbl.start + 8, stbl.end);
    const findStbl = (type) => find(stblBoxes, type);
    if (process.env.BDG_VERBOSE) {
      console.log('  trak' + ti + ' stbl children:', stblBoxes.map(b => b.type + '@' + b.start + ' size=' + (b.end - b.start)).join(' | '));
    }

    // dinf/dref 结构校验：dref 必须是 version+flags=0、entry_count=1，随后紧跟 url 盒。
    // （曾因漏写 4 字节 version+flags 导致 entry_count 被解析为 url 盒大小 → Media Foundation 拒播，
    //  而 VLC/mp4box 宽容放行，故必须有此断言）
    const dinf = find(sChildren, 'dinf');
    assert(dinf, 'minf 应含 dinf');
    const dref = readBoxes(dinf.start + 8, dinf.end)[0];
    assert(dref && dref.type === 'dref', 'dinf 内应含 dref 盒，实际 ' + (dref && dref.type));
    const drefVF = dv.getUint32(dref.start + 8);
    const drefCount = dv.getUint32(dref.start + 12);
    assert(drefVF === 0, 'dref version+flags 必须为 0，实际 ' + drefVF);
    assert(drefCount === 1, 'dref entry_count 必须为 1，实际 ' + drefCount);
    const urlBox = readBoxes(dref.start + 16, dref.end)[0];
    assert(urlBox && urlBox.type === 'url ', 'dref 首个条目应为 url 盒，实际 ' + (urlBox && urlBox.type));
    assert((dv.getUint32(urlBox.start + 8) & 0xffffff) === 1, 'url 盒 flags 应为 1（数据自包含）');
    assert(urlBox.end === dref.end, 'dref 内不应有多余字节');

    const stsd = findStbl('stsd');
    // stsd: [头8][v/f4][entry_count4] 后是条目盒 [size4][type4] → 类型 at +20
    const entryType = String.fromCharCode(u8[stsd.start + 20], u8[stsd.start + 21], u8[stsd.start + 22], u8[stsd.start + 23]);
    assert(entryType === exp.entry, `stsd 样本条目应为 ${exp.entry}，实际 ${JSON.stringify(entryType)}`);

    const stsz = findStbl('stsz');
    // stsz: [头8][v/f4][sample_size4][sample_count4] → count at +16, sizes at +20
    const stszCount = dv.getUint32(stsz.start + 16);
    assert(stszCount === exp.count, `stsz 样本数应为 ${exp.count}，实际 ${stszCount}`);

    const stts = findStbl('stts');
    const sttsEntryCount = dv.getUint32(stts.start + 12); // v/f(+8) + entry_count(+12)
    let sttsSum = 0;
    for (let i = 0; i < sttsEntryCount; i++) {
      const c = dv.getUint32(stts.start + 16 + i * 8);
      const d = dv.getUint32(stts.start + 20 + i * 8);
      sttsSum += c * d;
    }
    assert(sttsSum === exp.durSum, `stts 时长合计应为 ${exp.durSum}，实际 ${sttsSum}`);

    const stsc = findStbl('stsc');
    // stsc: [头8][v/f4][entry_count4][first_chunk4][samples_per_chunk4][sdi4] → 每块样本数 at +20
    const samplesPerChunk = dv.getUint32(stsc.start + 20);
    assert(samplesPerChunk === 1, 'stsc 每块 1 样本');

    const stco = findStbl('stco');
    const stcoCount = dv.getUint32(stco.start + 12); // entry_count at +12
    assert(stcoCount === exp.count, `stco 偏移数应为 ${exp.count}，实际 ${stcoCount}`);

    const mdatStart = mdat.start + 8;
    const mdatEnd = mdat.end;
    const sizes = [];
    for (let i = 0; i < stszCount; i++) sizes.push(dv.getUint32(stsz.start + 20 + i * 4));
    const offsets = [];
    for (let i = 0; i < stcoCount; i++) offsets.push(dv.getUint32(stco.start + 16 + i * 4));
    for (let i = 0; i < offsets.length; i++) {
      assert(offsets[i] >= mdatStart && offsets[i] + sizes[i] <= mdatEnd, `trak${exp.id} 样本${i} 偏移在 mdat 内`);
    }
    trackSizes[ti] = sizes;
    trackOffsets[ti] = offsets;

    // stss（视频轨道）
    const stss = findStbl('stss');
    if (exp.handler === 'vide') {
      assert(stss, '视频轨道应有 stss');
      const n = dv.getUint32(stss.start + 12);
      assert(n === 1, '视频关键帧应为 1 个');
      const first = dv.getUint32(stss.start + 16);
      assert(first === 1, '关键帧应为第 1 个样本');
    }

    // ctts（视频轨道应有 cto，音频无）
    const ctts = findStbl('ctts');
    if (exp.handler === 'vide') {
      assert(ctts, '视频轨道应有 ctts');
      const cttsN = dv.getUint32(ctts.start + 12);
      assert(cttsN >= 1, 'ctts 至少 1 个条目');
    } else {
      assert(!ctts, '音频轨道不应有 ctts');
    }
  }

  // 交错布局 + 数据往返校验：按 (视频0,音频0,视频1,音频1…) 的顺序，
  // 整个 mdat 载荷应被所有样本连续且无重叠地覆盖，且字节与源一致
  {
    const vSamples = makeVideoSamples();
    const aSamples = makeAudioSamples();
    const sources = [vSamples, aSamples];
    const mdatStart = mdat.start + 8;
    let cursor = mdatStart;
    let covered = 0;
    let layoutOk = true;
    let dataOk = true;
    const maxN = Math.max(trackSizes[0].length, trackSizes[1].length);
    for (let i = 0; i < maxN; i++) {
      for (let ti = 0; ti < 2; ti++) {
        const idx = i;
        if (idx >= trackSizes[ti].length) continue;
        const size = trackSizes[ti][idx];
        const off = trackOffsets[ti][idx];
        if (off !== cursor) layoutOk = false;
        for (let j = 0; j < size; j++) {
          if (u8[off + j] !== sources[ti][idx].data[j]) { dataOk = false; break; }
        }
        cursor += size;
        covered += size;
      }
    }
    assert(layoutOk, '交错布局偏移连续且覆盖整个 mdat 载荷');
    assert(dataOk, '所有样本数据与源一致');
    assert(covered === mdat.end - mdat.start - 8, 'mdat 载荷大小 = 所有样本大小之和');
  }

  // mdat 载荷大小 = 所有样本大小之和
  const vSamples = makeVideoSamples();
  const aSamples = makeAudioSamples();
  const expectData = vSamples.reduce((a, s) => a + s.size, 0) + aSamples.reduce((a, s) => a + s.size, 0);
  assert(mdat.end - mdat.start - 8 === expectData, 'mdat 载荷大小正确');
}

section('仅视频（无音频）');
{
  const vSamples = makeVideoSamples();
  const vFile = buildFmp4({ isVideo: true, samples: vSamples, timescale: 90000, duration: 30000 });
  const out = mergeToMp4(vFile);
  const u8 = out;
  const dv = new DataView(u8.buffer);
  let off = 0; const tops = [];
  while (off + 8 <= u8.length) {
    const size = dv.getUint32(off);
    const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
    if (size < 8 || off + size > u8.length) break;
    tops.push(type); off += size;
  }
  assert(tops.join(',') === 'ftyp,moov,mdat', '仅视频输出结构正确');
  // 逐字节定位 'moov' 类型字段（TypedArray.indexOf 不能搜索字节序列）
  let moovStart = -1;
  for (let i = 0; i + 4 <= u8.length; i++) {
    if (u8[i] === 0x6d && u8[i + 1] === 0x6f && u8[i + 2] === 0x6f && u8[i + 3] === 0x76) { moovStart = i - 4; break; }
  }
  assert(moovStart >= 0, '找到 moov 盒');
  let trakCount = 0; off = moovStart; const moovEnd = off + dv.getUint32(off);
  off += 8;
  while (off + 8 <= moovEnd) {
    const size = dv.getUint32(off);
    const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
    if (type === 'trak') trakCount++;
    off += size;
  }
  assert(trakCount === 1, '仅视频应只有 1 个 trak');
}

section('trex 默认时长（B站视频流真实结构）');
{
  const vSamples = makeVideoSamples();
  // trun 不含时长字段，时长/标志全部来自 moov/mvex/trex 默认值
  const vFile = buildFmp4({
    isVideo: true, samples: vSamples, timescale: 90000, duration: 30000,
    trex: { duration: 640, size: 0, flags: 0x01010000 }
  });
  const dbgSrc = src.replace('global.BDGMuxer = api;', 'global.BDGMuxer = api; global.BDGMuxer.__dbg = { parseFmp4: parseFmp4 };');
  const w2 = {};
  new Function('window', dbgSrc)(w2);
  const { parseFmp4 } = w2.BDGMuxer.__dbg;
  const parsed = parseFmp4(vFile);
  const s = parsed.tracks[0].samples;
  assert(s.length === 10, 'trex模式样本数应为 10，实际 ' + s.length);
  assert(s.every(x => x.duration === 640), '所有样本时长应取自 trex 默认值 640');
  // 每个分片(moof)的首样本带 first_sample_flags=0 → 关键帧（DASH 分段以关键帧开头），共 4 个分片
  const syncIdx = [0, 3, 6, 9];
  assert(s.every((x, i) => x.isSync === syncIdx.includes(i)), '关键帧应为每个分片的首样本(0,3,6,9)，实际 ' + s.map((x, i) => (x.isSync ? i : '')).filter(v => v !== '').join(','));
  assert(s[0].isSync === true, '首样本(first_sample_flags=0)应为关键帧');

  // 合并输出：stts 总和与 mdhd duration 应为 10×640=6400
  const out = mergeToMp4(vFile);
  const outU8 = out;
  const outDv = new DataView(outU8.buffer, outU8.byteOffset, outU8.byteLength);
  function walk(start, end, pred) {
    const found = [];
    let o = start;
    while (o + 8 <= end) {
      const size = outDv.getUint32(o);
      const t = String.fromCharCode(outU8[o + 4], outU8[o + 5], outU8[o + 6], outU8[o + 7]);
      if (size < 8 || o + size > end) break;
      if (pred(t)) found.push({ t, start: o, end: o + size });
      o += size;
    }
    return found;
  }
  const moov = walk(0, outU8.length, t => t === 'moov')[0];
  const traks = walk(moov.start + 8, moov.end, t => t === 'trak');
  const tKids = walk(traks[0].start + 8, traks[0].end, () => true);
  const mdia = tKids.find(b => b.t === 'mdia');
  const mKids = walk(mdia.start + 8, mdia.end, () => true);
  const mdhd = mKids.find(b => b.t === 'mdhd');
  const mdhdDur = outDv.getUint32(mdhd.start + 24);
  const minf = mKids.find(b => b.t === 'minf');
  const stbl = walk(minf.start + 8, minf.end, t => t === 'stbl')[0];
  const stblKids = walk(stbl.start + 8, stbl.end, () => true);
  const stts = stblKids.find(b => b.t === 'stts');
  const sttsN = outDv.getUint32(stts.start + 12);
  let sttsSum = 0;
  for (let i = 0; i < sttsN; i++) sttsSum += outDv.getUint32(stts.start + 16 + i * 8) * outDv.getUint32(stts.start + 20 + i * 8);
  assert(sttsSum === 6400, `合并输出 stts 总和应为 6400，实际 ${sttsSum}`);
  assert(mdhdDur === 6400, `合并输出 mdhd duration 应为 6400，实际 ${mdhdDur}`);
  const stss = stblKids.find(b => b.t === 'stss');
  if (stss) {
    const n = outDv.getUint32(stss.start + 12);
    const nums = [];
    for (let i = 0; i < n; i++) nums.push(outDv.getUint32(stss.start + 16 + i * 4));
    assert(n === 4 && nums.join(',') === '1,4,7,10', `关键帧表应为 1,4,7,10，实际 ${nums.join(',')}`);
  } else {
    assert(false, '应有 stss 关键帧表');
  }
}

section('异常输入');
{
  let threw = false;
  try { mergeToMp4(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0])); } catch (e) { threw = true; }
  assert(threw, '垃圾输入应抛错');
}

console.log(`\n========== 结果：${passed} 通过, ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
