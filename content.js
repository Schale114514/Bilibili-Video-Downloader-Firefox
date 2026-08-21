/*
 * content.js — B站视频下载器 主逻辑
 * 在视频页右下角显示浮动按钮“打开B站视频下载”，点击弹出下载面板：
 *   分P选择 / 清晰度 / 编码 / 下载格式 / 进度条 / 日志
 * 通过 B站官方 API 获取分片流(DASH)，使用 lib/muxer.js 在浏览器内合并为 MP4。
 */
(() => {
  'use strict';

  if (window.__BDG_INSTALLED__) return;
  window.__BDG_INSTALLED__ = true;

  // 支持的播放页：普通视频 / 番剧影视 / 课程 / 稍后再看·收藏夹·合集等列表播放页(/list/、/medialist/play/)
  const IS_VIDEO_PAGE = /^\/(video|bangumi\/play|cheese\/play|list|medialist\/play)\//.test(location.pathname);
  if (!IS_VIDEO_PAGE) return;

  /* ---------------- 常量 ---------------- */
  const QN_LABELS = {
    127: '8K', 126: '杜比视界', 125: 'HDR', 120: '4K', 116: '1080P60',
    112: '1080P+', 100: '智能修复', 80: '1080P', 74: '720P60', 64: '720P',
    32: '480P', 16: '360P'
  };
  const CODEC_MAP = { 7: 'AVC', 12: 'HEVC', 13: 'AV1' };
  const CODEC_PREF = [7, 12, 13];          // 优先 H.264，其次 HEVC，最后 AV1
  const AAC_PREF = [30232, 30216, 30280, 30250];

  /* ---------------- 状态 ---------------- */
  const state = {
    open: false,
    info: null,
    playurl: null,
    qualities: [],        // [{qn,label,needVip,needLogin,codecs:[codecid]}]
    qn: 0,
    codecId: 7,
    fmt: 'merge',
    busy: false,
    abortCtl: null,
    lastSpeedTs: 0,
    lastSpeedBytes: 0,
    speed: 0
  };

  /* ---------------- 小工具 ---------------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtSize(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n.toFixed(0) : (n >= 100 ? n.toFixed(0) : n.toFixed(1))) + ' ' + u[i];
  }
  function fmtTime(s) {
    s = Math.round(s || 0);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(ss).padStart(2, '0');
  }
  function cleanName(s) {
    return String(s || 'bilibili').replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'bilibili';
  }
  // 返回流地址列表（主地址 + 备用地址，备用地址在 main 失败时自动重试）
  function streamUrls(s) {
    if (!s) return [];
    const list = [];
    if (s.baseUrl) list.push(s.baseUrl);
    const backups = s.backupUrl || s.backup_url || [];
    for (const u of backups) { if (u && list.indexOf(u) < 0) list.push(u); }
    return list;
  }
  function hostOf(url) {
    try { return new URL(url).host; } catch (e) { return '未知'; }
  }

  async function apiGet(url) {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error('请求失败 HTTP ' + resp.status);
    return resp.json();
  }

  /* ---------------- 视频信息 / 播放地址 ---------------- */
  function currentBvid() {
    // 路径形式：/video/BV... ；列表播放页(稍后再看/收藏夹/合集)的 bvid 在查询参数里
    const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    if (m) return m[1];
    const q = new URLSearchParams(location.search).get('bvid');
    return q && /^BV[0-9A-Za-z]+$/.test(q) ? q : null;
  }

  // 列表播放页的 oid 查询参数即 aid
  function currentAid() {
    const oid = new URLSearchParams(location.search).get('oid');
    return oid && /^\d+$/.test(oid) ? +oid : null;
  }

  // 解析番剧/影视/纪录片播放页 URL：/bangumi/play/ep123 或 /bangumi/play/ss123
  function parsePgcFromUrl() {
    const m = location.pathname.match(/\/bangumi\/play\/(ep|ss)(\d+)/);
    return m ? { type: m[1], id: +m[2] } : null;
  }

  // 番剧/影视/纪录片：组合标题（剧集名 - 单集名）
  function pgcTitle(media, ep) {
    const epTitle = (ep && (ep.long_title || ep.title)) || '';
    const seriesTitle = (media && (media.title || media.media_title)) || '';
    if (seriesTitle && epTitle) return seriesTitle + ' - ' + epTitle;
    return seriesTitle || epTitle || '未知标题';
  }

  async function loadInfo() {
    const st = window.__INITIAL_STATE__;

    // 1) 普通视频页：window.__INITIAL_STATE__.videoData
    if (st && st.videoData) {
      const vd = st.videoData;
      const pages = (vd.pages && vd.pages.length ? vd.pages : [{ cid: vd.cid, page: 1, part: vd.title, duration: vd.duration }])
        .map((p) => ({ cid: p.cid, page: p.page, part: p.part || ('P' + p.page), duration: p.duration }));
      return { bvid: vd.bvid, aid: vd.aid, cid: vd.cid, title: vd.title || '未知标题', pages };
    }

    // 2) 番剧/影视/纪录片播放页：window.__INITIAL_STATE__.epInfo（已购买/大会员可直接解析）
    if (st && st.epInfo) {
      const ep = st.epInfo;
      const media = st.mediaInfo || {};
      const epTitle = ep.long_title || ep.title || '';
      const pages = [{ cid: ep.cid, page: 1, part: epTitle || media.title || 'P1', duration: ep.duration || 0 }];
      return { bvid: ep.bvid || null, aid: ep.aid || null, cid: ep.cid, title: pgcTitle(media, ep), pages, epId: ep.id };
    }

    // 3) 普通视频 URL 回退：/video/BV... 或列表播放页查询参数 bvid
    const bvid = currentBvid();
    if (bvid) {
      const j = await apiGet('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid);
      if (j.code !== 0) throw new Error('获取视频信息失败：' + (j.message || j.code));
      const d = j.data;
      const pages = (d.pages && d.pages.length ? d.pages : [{ cid: d.cid, page: 1, part: d.title, duration: d.duration }])
        .map((p) => ({ cid: p.cid, page: p.page, part: p.part || ('P' + p.page), duration: p.duration }));
      return { bvid: d.bvid, aid: d.aid, cid: d.cid, title: d.title || '未知标题', pages };
    }

    // 3.5) 列表播放页仅有 oid(=aid) 时的回退
    const aid = currentAid();
    if (aid) {
      const j = await apiGet('https://api.bilibili.com/x/web-interface/view?aid=' + aid);
      if (j.code !== 0) throw new Error('获取视频信息失败：' + (j.message || j.code));
      const d = j.data;
      const pages = (d.pages && d.pages.length ? d.pages : [{ cid: d.cid, page: 1, part: d.title, duration: d.duration }])
        .map((p) => ({ cid: p.cid, page: p.page, part: p.part || ('P' + p.page), duration: p.duration }));
      return { bvid: d.bvid, aid: d.aid, cid: d.cid, title: d.title || '未知标题', pages };
    }

    // 4) 番剧/影视/纪录片 URL 回退：通过 pgc 接口查询剧集信息
    const pgc = parsePgcFromUrl();
    if (pgc) {
      const j = await apiGet('https://api.bilibili.com/pgc/view/web/season?' + (pgc.type === 'ep' ? 'ep_id=' + pgc.id : 'season_id=' + pgc.id));
      if (j.code !== 0) throw new Error('获取影视信息失败：' + (j.message || j.code));
      const d = j.result || j.data || {};
      let ep = null;
      if (pgc.type === 'ep') ep = (d.episodes || []).find((e) => e.id === pgc.id);
      if (!ep) ep = (d.episodes || [])[0];
      if (!ep) throw new Error('未找到该集信息，请确认已购买或开通大会员');
      const epTitle = ep.long_title || ep.title || '';
      const pages = [{ cid: ep.cid, page: 1, part: epTitle || d.title || 'P1', duration: ep.duration || 0 }];
      return { bvid: ep.bvid || null, aid: ep.aid || null, cid: ep.cid, title: pgcTitle(d, ep), pages, epId: pgc.type === 'ep' ? pgc.id : (ep.id || null) };
    }

    throw new Error('未识别到当前视频页面');
  }

  async function loadPlayurl(info, cid) {
    let j;
    if (info.epId) {
      // 番剧/影视/纪录片：pgc 播放地址接口（需登录/购买）
      // 注意：pgc 系接口返回的数据在 result 字段（普通视频接口才是 data）
      j = await apiGet('https://api.bilibili.com/pgc/player/web/playurl?ep_id=' + info.epId + '&qn=127&fnval=4048&fourk=1&platform=pc');
    } else if (info.bvid) {
      j = await apiGet('https://api.bilibili.com/x/player/playurl?bvid=' + info.bvid + '&cid=' + cid + '&qn=127&fnval=4048&fourk=1&platform=pc');
    } else if (info.aid) {
      j = await apiGet('https://api.bilibili.com/x/player/playurl?avid=' + info.aid + '&cid=' + cid + '&qn=127&fnval=4048&fourk=1&platform=pc');
    } else {
      throw new Error('无法构造播放地址');
    }
    if (j.code !== 0) throw new Error('获取播放地址失败：' + (j.message || j.code));
    const payload = j.result || j.data;
    if (!payload) throw new Error('获取播放地址失败：响应数据为空');
    return payload;
  }

  function buildQualityList(data) {
    if (!data) throw new Error('播放地址数据为空');
    const dash = data.dash;
    const dashVids = dash ? dash.video : [];
    const durl = data.durl || [];
    const byQn = new Map();
    for (const v of dashVids) {
      if (!byQn.has(v.id)) byQn.set(v.id, { codecs: new Set() });
      if (v.codecid) byQn.get(v.id).codecs.add(v.codecid);
    }
    const list = [];
    const fmts = data.support_formats || [];
    for (const f of fmts) {
      const q = f.quality;
      if (byQn.has(q)) {
        list.push({ qn: q, label: f.new_description || f.display_desc || QN_LABELS[q] || (q + 'P'), needVip: !!f.need_vip, needLogin: !!f.need_login, codecs: Array.from(byQn.get(q).codecs) });
      } else if (durl.length && q === data.quality) {
        list.push({ qn: q, label: f.new_description || f.display_desc || QN_LABELS[q] || (q + 'P'), needVip: !!f.need_vip, needLogin: !!f.need_login, codecs: [] });
      }
    }
    if (!list.length) {
      (data.accept_quality || []).forEach((q, i) => {
        if (dashVids.some((v) => v.id === q) || (durl.length && q === data.quality)) {
          list.push({ qn: q, label: (data.accept_description || [])[i] || QN_LABELS[q] || (q + 'P'), needVip: false, needLogin: false, codecs: [] });
        }
      });
    }
    return list;
  }

  function pickStreams(data, qn, codecId) {
    const dash = data.dash;
    if (!dash) {
      const durl = data.durl || [];
      if (!durl.length) throw new Error('该视频没有可用的下载地址');
      return { type: 'durl', segments: durl.map((d) => d.url).filter(Boolean), quality: data.quality };
    }
    const vids = dash.video.filter((v) => v.id === qn);
    if (!vids.length) throw new Error('所选清晰度不可用');
    const order = [codecId].concat(CODEC_PREF.filter((c) => c !== codecId));
    let video = null;
    for (const c of order) { video = vids.find((v) => v.codecid === c); if (video) break; }
    if (!video) video = vids[0];
    let audio = null;
    for (const id of AAC_PREF) { audio = (dash.audio || []).find((a) => a.id === id); if (audio) break; }
    if (!audio && dash.audio && dash.audio.length) audio = dash.audio[0];
    return { type: 'dash', video: video, audio: audio };
  }

  /* ---------------- 下载流（直连，失败走后台通道） ---------------- */
  async function fetchStream(url, onProgress, signal) {
    try {
      // 媒体流不需要 Cookie：带凭据的跨域请求会被 CORS 策略拦截（Failed to fetch）
      const resp = await fetch(url, { credentials: 'omit', signal, referrerPolicy: 'unsafe-url' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const total = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
      const reader = resp.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        chunks.push(r.value);
        received += r.value.byteLength;
        if (onProgress) onProgress(received, total);
      }
      const buf = new Uint8Array(received);
      let o = 0;
      for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
      return { arrayBuffer: buf.buffer, total: received };
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      if (e && /^HTTP \d+/.test(e.message)) throw e; // 服务器明确拒绝，交给外层换备用地址
      // 网络 / CORS 类错误（如 Failed to fetch）→ 改走扩展后台（拥有 host 权限，不受页面 CORS 限制）
      log('直连 ' + hostOf(url) + ' 被拦截，切换后台通道重试…');
      return fetchViaBackground(url, onProgress, signal);
    }
  }

  // 依次尝试多个地址（主 + 备用），每个地址先直连、失败后再走后台通道
  async function downloadStream(urls, onProgress, signal) {
    const list = (urls || []).filter(Boolean);
    if (!list.length) throw new Error('该流没有可用的下载地址');
    let lastErr = null;
    for (let i = 0; i < list.length; i++) {
      try {
        return await fetchStream(list[i], onProgress, signal);
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        lastErr = e;
        log('地址 ' + (i + 1) + '/' + list.length + ' 失败（' + hostOf(list[i]) + '）：' + e.message);
      }
    }
    throw lastErr || new Error('下载失败');
  }

  function fetchViaBackground(url, onProgress, signal) {
    return new Promise((resolve, reject) => {
      let port = null;
      let done = false;
      const chunks = [];
      let received = 0, total = 0;
      const fail = (err) => { if (done) return; done = true; try { port && port.disconnect(); } catch (_) { /* */ } reject(err); };
      const abort = () => fail(new DOMException('Aborted', 'AbortError'));
      if (signal) {
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
      }
      try {
        port = chrome.runtime.connect({ name: 'dl-stream' });
      } catch (e) {
        reject(new Error('后台通道不可用：' + e.message));
        return;
      }
      port.onMessage.addListener((msg) => {
        if (!msg) return;
        if (msg.type === 'meta') {
          total = msg.total || 0;
          if (!msg.ok) fail(new Error('HTTP ' + msg.status));
        } else if (msg.type === 'chunk') {
          const u = new Uint8Array(msg.data);
          chunks.push(u);
          received += u.byteLength;
          if (onProgress) onProgress(received, total);
        } else if (msg.type === 'done') {
          done = true;
          try { port.disconnect(); } catch (_) { /* */ }
          const buf = new Uint8Array(received);
          let o = 0;
          for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
          resolve({ arrayBuffer: buf.buffer, total: received });
        } else if (msg.type === 'error') {
          fail(new Error('后台通道：' + (msg.error || '下载失败')));
        }
      });
      port.postMessage({ type: 'start', url: url });
    });
  }

  /* ---------------- 保存文件 ---------------- */
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
  }

  /* ---------------- 主下载流程 ---------------- */
  async function runDownload() {
    if (state.busy || !state.info || !state.playurl) return;
    const info = state.info;
    const data = state.playurl;
    const qn = state.qn;
    const codecId = state.codecId;
    const fmt = state.fmt;
    const curPage = (info.pages || []).find((p) => p.page === currentPartPage()) || (info.pages || [])[0] || {};
    const ctl = new AbortController();
    state.abortCtl = ctl;
    state.busy = true;
    $('#bdgDownload').disabled = true;
    $('#bdgCancel').hidden = false;
    $('#bdgProgress').hidden = false;
    setProgress(0, 0);
    log('开始下载…');
    try {
      const titleBase = cleanName(info.title) + (info.pages && info.pages.length > 1 ? ' - P' + (curPage.page || 1) : '');
      const streams = pickStreams(data, qn, codecId);

      if (streams.type === 'durl') {
        const segs = [];
        let totalBytes = 0;
        for (let i = 0; i < streams.segments.length; i++) {
          setStatus('下载分片 ' + (i + 1) + '/' + streams.segments.length + '…');
          const r = await downloadStream([streams.segments[i]], (rec, tot) => updateProgress(rec, tot), ctl.signal);
          segs.push(r.arrayBuffer);
          totalBytes += r.total;
        }
        saveBlob(new Blob(segs, { type: 'video/mp4' }), titleBase + '.mp4');
        setStatus('✅ 下载完成');
        setProgress(1, totalBytes);
        log('已保存：' + titleBase + '.mp4（直链 MP4）');
        return;
      }

      const vUrls = streamUrls(streams.video);
      const aUrls = streamUrls(streams.audio);
      const hasA = aUrls.length > 0;
      const needV = fmt !== 'audio';
      const needA = fmt === 'merge' || fmt === 'audio' || fmt === 'separate';
      let vBuf = null, aBuf = null, vTotal = 0, aTotal = 0;

      if (needV && vUrls.length) {
        setStatus('下载视频流…');
        const r = await downloadStream(vUrls, (rec, tot) => updateProgress(rec, tot, 0, 0), ctl.signal);
        vBuf = r.arrayBuffer;
        vTotal = r.total;
      }
      if (needA && hasA) {
        setStatus('下载音频流…');
        const r = await downloadStream(aUrls, (rec, tot) => updateProgress(vTotal, vTotal, rec, tot), ctl.signal);
        aBuf = r.arrayBuffer;
        aTotal = r.total;
      }

      if (fmt === 'audio' && aBuf) {
        saveBlob(new Blob([aBuf], { type: 'audio/mp4' }), titleBase + '.m4a');
        setStatus('✅ 下载完成');
        log('已保存：' + titleBase + '.m4a');
        return;
      }
      if (fmt === 'video' && vBuf) {
        saveBlob(new Blob([vBuf], { type: 'video/mp4' }), titleBase + '.mp4');
        setStatus('✅ 下载完成');
        log('已保存：' + titleBase + '.mp4（仅视频，无音轨）');
        return;
      }
      if (fmt === 'separate') {
        if (vBuf) saveBlob(new Blob([vBuf], { type: 'video/mp4' }), titleBase + '_视频.mp4');
        if (aBuf) saveBlob(new Blob([aBuf], { type: 'audio/mp4' }), titleBase + '_音频.m4a');
        setStatus('✅ 下载完成（分别保存）');
        log('已保存视频与音频两个文件');
        return;
      }

      // merge：合并音视频为单个 MP4
      if (!vBuf || !aBuf) {
        if (vBuf) saveBlob(new Blob([vBuf], { type: 'video/mp4' }), titleBase + '.mp4');
        setStatus('✅ 下载完成（无音轨，已保存视频）');
        return;
      }
      setStatus('正在合并音视频…');
      setIndeterminate(true);
      let merged = null;
      try {
        if (!window.BDGMuxer) throw new Error('合并模块未加载');
        merged = window.BDGMuxer.mergeToMp4(vBuf, aBuf);
      } catch (e) {
        log('合并失败（' + e.message + '），改为分别保存');
      }
      setIndeterminate(false);
      if (merged) {
        saveBlob(new Blob([merged], { type: 'video/mp4' }), titleBase + '.mp4');
        setStatus('✅ 下载完成');
        setProgress(1, vTotal + aTotal);
        log('已保存合并后的 MP4：' + titleBase + '.mp4');
      } else {
        saveBlob(new Blob([vBuf], { type: 'video/mp4' }), titleBase + '_视频.mp4');
        saveBlob(new Blob([aBuf], { type: 'audio/mp4' }), titleBase + '_音频.m4a');
        setStatus('✅ 下载完成（分别保存）');
      }
    } catch (e) {
      el('bdgStatus').textContent = '';
      if (e && e.name === 'AbortError') {
        setStatus('已取消');
        log('下载已取消');
      } else {
        setStatus('❌ 失败：' + e.message);
        log('错误：' + e.message);
        log('提示：可尝试刷新页面、确认已登录后重试；若仍失败，请把以上日志反馈给我排查');
      }
    } finally {
      state.busy = false;
      state.abortCtl = null;
      $('#bdgDownload').disabled = false;
      $('#bdgCancel').hidden = true;
    }
  }

  /* 进度：视频/音频两路合并展示 */
  const _prog = { vRec: 0, vTot: 0, aRec: 0, aTot: 0 };
  function updateProgress(vRec, vTot, aRec, aTot) {
    _prog.vRec = vRec || 0; _prog.vTot = vTot || 0; _prog.aRec = aRec || 0; _prog.aTot = aTot || 0;
    const total = _prog.vTot + _prog.aTot;
    const rec = _prog.vRec + _prog.aRec;
    if (total > 0) setProgress(rec / total, total);
  }

  /* ---------------- UI 构建 ---------------- */
  const root = document.createElement('div');
  root.id = 'bdg-root';
  root.className = document.documentElement.classList.contains('dark') ? 'bdg-dark' : '';
  root.innerHTML =
    '<button id="bdgFab" class="bdg-fab" title="B站视频下载">📥 打开B站视频下载</button>' +
    '<div id="bdgPanel" class="bdg-panel" hidden>' +
    '  <div class="bdg-head"><span class="bdg-title">📥 B站视频下载</span>' +
    '    <button id="bdgClose" class="bdg-close" title="关闭">✕</button></div>' +
    '  <div class="bdg-body">' +
    '    <div class="bdg-vinfo">' +
    '      <div id="bdgVtitle" class="bdg-vtitle">正在读取视频信息…</div>' +
    '      <div id="bdgVmeta" class="bdg-vmeta"></div></div>' +
    '    <div id="bdgPartSec" class="bdg-sec" hidden>' +
    '      <div class="bdg-sec-title">分P选择</div><select id="bdgPart"></select></div>' +
    '    <div class="bdg-sec">' +
    '      <div class="bdg-sec-title">清晰度</div><div id="bdgQualities" class="bdg-ql"></div></div>' +
    '    <div id="bdgCodecSec" class="bdg-sec" hidden>' +
    '      <div class="bdg-sec-title">编码</div><div id="bdgCodecs" class="bdg-codec"></div></div>' +
    '    <div class="bdg-sec">' +
    '      <div class="bdg-sec-title">下载格式</div><div id="bdgFormats" class="bdg-fmt"></div></div>' +
    '    <div class="bdg-actions">' +
    '      <button id="bdgDownload" class="bdg-btn bdg-btn-primary">开始下载</button>' +
    '      <button id="bdgCancel" class="bdg-btn" hidden>取消</button></div>' +
    '    <div id="bdgProgress" class="bdg-progress" hidden>' +
    '      <div id="bdgTask" class="bdg-task"></div>' +
    '      <div class="bdg-bar"><div id="bdgBar" class="bdg-bar-in"></div></div>' +
    '      <div id="bdgStatus" class="bdg-status"></div></div>' +
    '    <div id="bdgLog" class="bdg-log"></div>' +
    '  </div></div>';
  document.documentElement.appendChild(root);

  function el(id) { return document.getElementById(id); }

  function log(msg) {
    const l = el('bdgLog');
    const div = document.createElement('div');
    div.textContent = msg;
    l.appendChild(div);
    l.scrollTop = l.scrollHeight;
  }
  function setStatus(t) { el('bdgTask').textContent = t; }
  function setProgress(frac, totalBytes) {
    const bar = el('bdgBar');
    const pct = Math.max(0, Math.min(1, frac));
    bar.style.width = (pct * 100).toFixed(2) + '%';
    // 估算速度
    const now = Date.now();
    if (state.lastSpeedTs) {
      const dt = (now - state.lastSpeedTs) / 1000;
      if (dt >= 0.8) {
        state.speed = Math.max(0, (totalBytes * pct - state.lastSpeedBytes) / dt);
        state.lastSpeedBytes = totalBytes * pct;
        state.lastSpeedTs = now;
      }
    } else {
      state.lastSpeedTs = now;
      state.lastSpeedBytes = totalBytes * pct;
    }
    const size = totalBytes * pct;
    const remain = pct > 0 && state.speed > 0 ? (totalBytes * (1 - pct)) / state.speed : 0;
    el('bdgStatus').textContent = (pct * 100).toFixed(0) + '% · ' + fmtSize(size) + ' / ' + fmtSize(totalBytes) +
      (state.speed > 0 ? ' · ' + fmtSize(state.speed) + '/s · 剩余 ' + fmtTime(remain) : '');
  }
  function setIndeterminate(on) {
    el('bdgBar').classList.toggle('bdg-indeterminate', !!on);
  }

  /* ---------------- 面板打开 / 刷新 ---------------- */
  function openPanel() {
    state.open = true;
    el('bdgPanel').hidden = false;
    el('bdgFab').classList.add('bdg-fab-active');
    refresh();
  }
  function closePanel() {
    state.open = false;
    el('bdgPanel').hidden = true;
    el('bdgFab').classList.remove('bdg-fab-active');
  }

  function currentPartPage() {
    const st = window.__INITIAL_STATE__;
    return st && st.p ? st.p : 1;
  }

  let refreshing = false;
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      state.info = await loadInfo();
      el('bdgVtitle').textContent = state.info.title;
      el('bdgVtitle').title = state.info.title;
      const up = state.info.bvid ? ('BV号：' + state.info.bvid + ' · 共' + (state.info.pages || []).length + 'P') : '';
      el('bdgVmeta').textContent = up;
      // 分P
      if (state.info.pages && state.info.pages.length > 1) {
        el('bdgPartSec').hidden = false;
        const sel = el('bdgPart');
        sel.innerHTML = '';
        state.info.pages.forEach((p) => {
          const o = document.createElement('option');
          o.value = p.page;
          o.textContent = 'P' + p.page + ' ' + (p.part || '') + (p.duration ? ' (' + fmtTime(p.duration) + ')' : '');
          sel.appendChild(o);
        });
        sel.value = String(currentPartPage());
      } else {
        el('bdgPartSec').hidden = true;
      }
      await loadQualityFor(currentPartPage());
      renderFormats();
      restorePrefs();
    } catch (e) {
      el('bdgVtitle').textContent = '⚠️ ' + e.message;
      el('bdgVmeta').textContent = '请刷新页面后重试，或检查是否登录';
      el('bdgQualities').innerHTML = '';
      el('bdgCodecSec').hidden = true;
    } finally {
      refreshing = false;
    }
  }

  async function loadQualityFor(page) {
    const info = state.info;
    const p = info.pages.find((x) => x.page === page) || info.pages[0];
    if (!p) throw new Error('找不到该分P');
    const data = await loadPlayurl(info, p.cid);
    state.playurl = data;
    state.qualities = buildQualityList(data);
    renderQualities();
  }

  /* ---------------- 渲染：清晰度 / 编码 / 格式 ---------------- */
  function renderQualities() {
    const box = el('bdgQualities');
    box.innerHTML = '';
    if (!state.qualities.length) {
      box.innerHTML = '<div class="bdg-empty">暂无可下载的清晰度（可能未登录或该视频受限制）</div>';
      return;
    }
    if (!state.qn || !state.qualities.some((q) => q.qn === state.qn)) {
      // 默认选最高的非 VIP 档（优先 1080P）
      state.qn = state.qualities.find((q) => q.qn <= 80 && !q.needVip) ? state.qualities.find((q) => q.qn <= 80 && !q.needVip).qn : state.qualities[0].qn;
    }
    state.qualities.forEach((q) => {
      const row = document.createElement('div');
      row.className = 'bdg-ql-item' + (q.qn === state.qn ? ' bdg-ql-sel' : '');
      row.dataset.qn = q.qn;
      row.innerHTML =
        '<span class="bdg-ql-name">' + esc(q.label) + '</span>' +
        (q.codecs.length ? '<span class="bdg-ql-codecs">' + q.codecs.map((c) => esc(CODEC_MAP[c] || '编码' + c)).join('/') + '</span>' : '') +
        (q.needVip ? '<span class="bdg-ql-badge bdg-badge-vip">大会员</span>' : '') +
        (q.needLogin ? '<span class="bdg-ql-badge">需登录</span>' : '');
      row.addEventListener('click', () => {
        state.qn = q.qn;
        box.querySelectorAll('.bdg-ql-item').forEach((x) => x.classList.toggle('bdg-ql-sel', +x.dataset.qn === q.qn));
        renderCodecs();
        savePrefs();
      });
      box.appendChild(row);
    });
    renderCodecs();
  }

  function renderCodecs() {
    const q = state.qualities.find((x) => x.qn === state.qn);
    const codecs = q && q.codecs && q.codecs.length ? q.codecs : [];
    const sec = el('bdgCodecSec');
    const box = el('bdgCodecs');
    if (codecs.length < 2) {
      sec.hidden = true;
      state.codecId = codecs.length ? codecs[0] : 7;
      return;
    }
    // 按偏好排序
    const sorted = codecs.slice().sort((a, b) => CODEC_PREF.indexOf(a) - CODEC_PREF.indexOf(b));
    if (!sorted.includes(state.codecId)) state.codecId = sorted[0];
    sec.hidden = false;
    box.innerHTML = '';
    sorted.forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bdg-codec-btn' + (c === state.codecId ? ' bdg-codec-sel' : '');
      b.textContent = CODEC_MAP[c] || ('编码' + c);
      b.addEventListener('click', () => {
        state.codecId = c;
        box.querySelectorAll('.bdg-codec-btn').forEach((x) => x.classList.toggle('bdg-codec-sel', x === b));
        savePrefs();
      });
      box.appendChild(b);
    });
  }

  function renderFormats() {
    const box = el('bdgFormats');
    const defs = [
      { v: 'merge', t: '合并音视频（MP4，推荐）' },
      { v: 'video', t: '仅视频（无声音）' },
      { v: 'audio', t: '仅音频（M4A）' },
      { v: 'separate', t: '视频+音频（两个文件）' }
    ];
    box.innerHTML = '';
    defs.forEach((d) => {
      const lab = document.createElement('label');
      lab.className = 'bdg-fmt-item';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'bdgFmt';
      radio.value = d.v;
      radio.checked = state.fmt === d.v;
      radio.addEventListener('change', () => { state.fmt = d.v; savePrefs(); });
      lab.appendChild(radio);
      lab.appendChild(document.createTextNode(d.t));
      box.appendChild(lab);
    });
  }

  /* ---------------- 偏好记忆 ---------------- */
  function savePrefs() {
    try {
      chrome.storage.local.set({ bdgQn: state.qn, bdgCodec: state.codecId, bdgFmt: state.fmt });
    } catch (e) { /* ignore */ }
  }
  function restorePrefs() {
    try {
      chrome.storage.local.get(['bdgQn', 'bdgCodec', 'bdgFmt'], (r) => {
        if (!r) return;
        if (r.bdgQn && state.qualities.some((q) => q.qn === r.bdgQn)) state.qn = r.bdgQn;
        if (r.bdgCodec) state.codecId = r.bdgCodec;
        if (r.bdgFmt) state.fmt = r.bdgFmt;
        renderQualities();
        renderFormats();
      });
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 事件绑定 ---------------- */
  el('bdgFab').addEventListener('click', () => {
    if (state.open) closePanel();
    else openPanel();
  });
  el('bdgClose').addEventListener('click', (e) => { e.stopPropagation(); closePanel(); });
  el('bdgClose').addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  el('bdgPart').addEventListener('change', async (e) => {
    const page = +e.target.value;
    try {
      await loadQualityFor(page);
      restorePrefs();
    } catch (err) {
      el('bdgVtitle').textContent = '⚠️ ' + err.message;
    }
  });
  el('bdgDownload').addEventListener('click', () => runDownload());
  el('bdgCancel').addEventListener('click', () => {
    if (state.abortCtl) state.abortCtl.abort();
  });

  // 点击面板外部任意处关闭（capture 阶段：即使关闭按钮被播放器浮层遮挡，点击仍能生效）
  document.addEventListener('pointerdown', (e) => {
    if (!state.open) return;
    if (e.target && root.contains(e.target)) return;
    closePanel();
  }, true);

  // ESC 键关闭面板
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.open) closePanel();
  });

  // 影视/纪录片播放页的播放器浮层常在页面加载后才挂载（同 z-index 时后挂载者在上），
  // 延迟把我们的根节点移到 <html> 末尾，确保面板始终浮在最上层
  const bumpZ = () => {
    try { document.documentElement.appendChild(root); } catch (_) { /* ignore */ }
  };
  setTimeout(bumpZ, 1200);
  window.addEventListener('load', bumpZ);

  // 深色模式跟随
  try {
    new MutationObserver(() => {
      const dark = document.documentElement.classList.contains('dark');
      root.classList.toggle('bdg-dark', dark);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  } catch (e) { /* ignore */ }

  /* ---------------- 全屏时自动隐藏（避免遮挡视频） ----------------
   * 两类全屏：
   *  1) Fullscreen API（“系统/浏览器全屏”按钮）：监听 fullscreenchange 事件
   *  2) B站“网页全屏”（纯 CSS 撑满视口，不触发任何事件）：轮询播放器几何位置检测
   */
  const fsState = { system: false, web: false, wasOpen: false, rootHidden: false };

  function applyFsVisibility() {
    const hide = fsState.system || fsState.web;
    if (hide && !fsState.rootHidden) {
      fsState.wasOpen = state.open;   // 记住进入全屏前的面板状态
      fsState.rootHidden = true;
      root.hidden = true;             // 隐藏整个 UI（按钮 + 面板）
    } else if (!hide && fsState.rootHidden) {
      fsState.rootHidden = false;
      root.hidden = false;
      if (!fsState.wasOpen) closePanel();  // 全屏前没开面板则保持关闭
    }
  }

  function onFullscreenChange() {
    fsState.system = !!(document.fullscreenElement || document.webkitFullscreenElement);
    applyFsVisibility();
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // 检测 B站“网页全屏”：播放器容器铺满整个视口即视为全屏（兼容新旧播放器）
  function detectWebFullscreen() {
    try {
      const list = document.querySelectorAll('.bpx-player-container, .player-container, [class*="fullscreen"], [class*="Fullscreen"]');
      for (const el of list) {
        const r = el.getBoundingClientRect();
        if (r.width >= window.innerWidth - 2 && r.height >= window.innerHeight - 2) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }
  setInterval(() => {
    fsState.web = detectWebFullscreen();
    applyFsVisibility();
  }, 600);
})();
