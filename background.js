/*
 * background.js — 扩展后台 Service Worker
 * 提供“流式下载”备用通道：当页面里的直连请求被 CORS 拦截时，
 * 由后台（拥有 host 权限，不受页面 CORS 限制）代为下载媒体流，
 * 并把数据块通过 Port 转发给 content script。
 */
'use strict';

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'dl-stream') return;

  let controller = null;

  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'start') {
      controller = new AbortController();
      (async () => {
        try {
          const resp = await fetch(msg.url, {
            credentials: 'omit',
            referrer: 'https://www.bilibili.com',
            signal: controller.signal
          });
          const total = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
          port.postMessage({ type: 'meta', ok: resp.ok, status: resp.status, total: total });
          if (!resp.ok || !resp.body) return;
          const reader = resp.body.getReader();
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            const chunk = r.value.buffer.slice(r.value.byteOffset, r.value.byteOffset + r.value.byteLength);
            port.postMessage({ type: 'chunk', data: chunk });
          }
          port.postMessage({ type: 'done' });
        } catch (e) {
          if (e && e.name === 'AbortError') return;
          try {
            port.postMessage({ type: 'error', error: String((e && e.message) || e) });
          } catch (_) { /* 端口已断开 */ }
        }
      })();
    } else if (msg.type === 'abort') {
      if (controller) controller.abort();
    }
  });

  port.onDisconnect.addListener(() => {
    if (controller) controller.abort();
  });
});
