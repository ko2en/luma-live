'use strict';

/**
 * 中继观众识别：把观众端的 candidateType 伪装成 relay，
 * 验证主播侧把它压到 mid 档并在状态栏单独标出「中继」。
 * 前提：本机已启动无口令服务（PORT=4903 node server.js）
 * 用法：node scripts/test-relay.js [studioUrl]
 */

const { spawn } = require('child_process');
const http = require('http');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9336;
const STUDIO_URL = process.argv[2] || 'http://127.0.0.1:4903/studio';
const VIEWER_URL = STUDIO_URL.replace(/\/studio.*$/, '/');

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

/* 只在观众页生效：把 getStats 结果里的 local-candidate 改成 relay，
   模拟「这一路正在走 TURN 中继」。真实的 WebRTC 链路不受影响。 */
const SPOOF_RELAY = `(() => {
  const orig = RTCPeerConnection.prototype.getStats;
  RTCPeerConnection.prototype.getStats = async function (...args) {
    const report = await orig.apply(this, args);
    const out = new Map();
    report.forEach((r) => {
      const copy = Object.assign({}, r);
      if (copy.type === 'local-candidate') copy.candidateType = 'relay';
      out.set(copy.id, copy);
    });
    return {
      forEach: (cb) => out.forEach((v, k) => cb(v, k)),
      get: (k) => out.get(k),
      has: (k) => out.has(k),
      get size() { return out.size; },
      [Symbol.iterator]: () => out[Symbol.iterator]()
    };
  };
})();`;

(async () => {
  const child = spawn(EDGE, [
    '--headless', '--disable-gpu', '--no-sandbox',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    `--remote-debugging-port=${PORT}`, '--user-data-dir=C:/tmp/edge-relay', 'about:blank'
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 80; i += 1) {
    try { targets = await httpJson('/json/list'); if (targets && targets.length) break; } catch (e) { /* retry */ }
    await sleep(250);
  }
  const hostTarget = (targets || []).find((t) => t.type === 'page');
  if (!hostTarget) throw new Error('no page target');

  const host = await connect(hostTarget.webSocketDebuggerUrl);
  await host.send('Page.navigate', { url: STUDIO_URL });
  await sleep(4000);
  await host.evaluate(`document.querySelector('[data-go-live]').click()`);
  await sleep(3000);

  // 观众页：先开 about:blank，注入伪装脚本，再跳转
  let viewerTarget = null;
  try {
    viewerTarget = await httpJson(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
  } catch (e) {
    viewerTarget = await httpJson(`/json/new?${encodeURIComponent('about:blank')}`, 'GET');
  }
  const viewer = await connect(viewerTarget.webSocketDebuggerUrl);
  await viewer.send('Page.addScriptToEvaluateOnNewDocument', { source: SPOOF_RELAY });
  await viewer.send('Page.navigate', { url: VIEWER_URL });

  // 等第一帧画面 + 至少一次 3 秒采样回报
  await sleep(12000);

  const out = {};
  out.viewer = await viewer.evaluate(`(() => {
    const v = document.querySelector('[data-video]');
    const s = v && v.srcObject;
    return {
      playing: document.querySelector('[data-player]').classList.contains('is-playing'),
      tracks: s ? s.getTracks().filter(t => t.readyState === 'live').length : 0
    };
  })()`);

  out.hostStatus = await host.evaluate(`(() => ({
    bitrate: (document.querySelector('[data-st-bitrate]') || {}).textContent,
    viewers: (document.querySelector('[data-st-viewers]') || {}).textContent
  }))()`);
  out.errors = { host: host.errors, viewer: viewer.errors };
  console.log(JSON.stringify(out, null, 2));

  host.ws.close();
  viewer.ws.close();
  child.kill();
  await sleep(300);

  const bar = out.hostStatus.bitrate || '';
  const ok = out.viewer.playing
    && out.viewer.tracks === 2
    && bar.includes('1 路中继')
    && bar.includes('1 路降档')
    && !out.errors.host.length && !out.errors.viewer.length;
  if (!ok) process.exitCode = 1;
})();
