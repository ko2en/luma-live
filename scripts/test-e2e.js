'use strict';

/**
 * 端到端：开播页开播 → 观众页收到画面
 * 前提：本机已启动无口令服务（PORT=4903 node server.js）
 * 用法：node scripts/test-e2e.js [studioUrl]
 */

const { spawn } = require('child_process');
const http = require('http');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9334;
const STUDIO_URL = process.argv[2] || 'http://127.0.0.1:4903/studio';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(path, method) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method: method || 'GET' }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(b.slice(0, 120))); } });
    });
    r.on('error', reject);
    r.end();
  });
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(d.exception ? d.exception.description : d.text);
    }
  };
  const send = (method, params) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, { resolve });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r && r.exceptionDetails) return { __error: r.exceptionDetails.text };
    return r && r.result ? r.result.value : undefined;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  return { ws, send, evaluate, errors };
}

(async () => {
  const child = spawn(EDGE, [
    '--headless', '--disable-gpu', '--no-sandbox',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    `--remote-debugging-port=${PORT}`, '--user-data-dir=C:/tmp/edge-e2e', 'about:blank'
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 80; i += 1) {
    try { targets = await httpJson('/json/list'); if (targets && targets.length) break; } catch (e) { /* retry */ }
    await sleep(250);
  }
  const studioTarget = (targets || []).find((t) => t.type === 'page');
  if (!studioTarget) throw new Error('no page target');

  const host = await connect(studioTarget.webSocketDebuggerUrl);
  await host.send('Page.navigate', { url: STUDIO_URL });
  await sleep(4000);

  const out = {};
  out.studioReady = await host.evaluate(`(() => {
    const row = document.querySelector('[data-key-row]');
    return {
      keyRowHidden: row ? row.hidden : null,
      status: (document.querySelector('[data-st-status]') || {}).textContent,
      btn: (document.querySelector('[data-go-live]') || {}).textContent
    };
  })()`);

  await host.evaluate(`document.querySelector('[data-go-live]').click()`);
  await sleep(3000);
  out.hostLive = await host.evaluate(`(() => ({
    badge: (document.querySelector('[data-live-badge]') || {}).textContent,
    status: (document.querySelector('[data-st-status]') || {}).textContent,
    res: (document.querySelector('[data-st-res]') || {}).textContent
  }))()`);

  // 新开观众页
  let viewerTarget = null;
  try {
    viewerTarget = await httpJson(`/json/new?${encodeURIComponent(STUDIO_URL.replace(/\/studio.*$/, '/'))}`, 'PUT');
  } catch (e) {
    viewerTarget = await httpJson(`/json/new?${encodeURIComponent(STUDIO_URL.replace(/\/studio.*$/, '/'))}`, 'GET');
  }

  const viewer = await connect(viewerTarget.webSocketDebuggerUrl);
  await sleep(6000);

  out.viewer = await viewer.evaluate(`(() => {
    const v = document.querySelector('[data-video]');
    const s = v && v.srcObject;
    return {
      playing: (document.querySelector('[data-player]') || {}).classList ? document.querySelector('[data-player]').classList.contains('is-playing') : null,
      tracks: s ? s.getTracks().map(t => t.kind + ':' + t.readyState) : [],
      currentTime: v ? Number(v.currentTime.toFixed(2)) : null,
      idleTitle: (document.querySelector('[data-idle-title]') || {}).textContent,
      live: (document.querySelector('[data-live-badge]') || {}).textContent
    };
  })()`);

  await sleep(4000);
  out.hostStats = await host.evaluate(`(() => ({
    bitrate: (document.querySelector('[data-st-bitrate]') || {}).textContent,
    viewers: (document.querySelector('[data-st-viewers]') || {}).textContent
  }))()`);

  // 观众刷新后能否自动重建连接
  await viewer.send('Page.navigate', { url: STUDIO_URL.replace(/\/studio.*$/, '/') });
  await sleep(7000);
  out.afterReload = await viewer.evaluate(`(() => {
    const v = document.querySelector('[data-video]');
    const s = v && v.srcObject;
    return {
      playing: document.querySelector('[data-player]').classList.contains('is-playing'),
      tracks: s ? s.getTracks().filter(t => t.readyState === 'live').length : 0,
      idleTitle: (document.querySelector('[data-idle-title]') || {}).textContent
    };
  })()`);

  out.hostErrors = host.errors;
  out.viewerErrors = viewer.errors;
  console.log(JSON.stringify(out, null, 2));

  host.ws.close();
  viewer.ws.close();
  child.kill();
  await sleep(300);

  const ok = out.hostLive.badge.includes('ON AIR')
    && out.viewer.tracks.length > 0
    && out.viewer.playing
    && out.afterReload.playing
    && !out.hostErrors.length && !out.viewerErrors.length;
  if (!ok) process.exitCode = 1;
})();
