'use strict';

/**
 * 中继观众识别：把观众端的 candidateType 伪装成 relay，
 * 验证主播侧把它压到 mid 档并在状态栏单独标出「中继」。
 * 前提：本机已启动无口令服务（PORT=4903 node server.js）
 * 用法：node scripts/test-relay.js [studioUrl]
 */

const { spawn } = require('child_process');
const http = require('http');
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function testSelectedLink() {
  const source = fs.readFileSync(path.join(__dirname, '../public/viewer.js'), 'utf8');
  const match = source.match(/  function selectedLink\(stats\) \{[\s\S]*?\n  \}\n/);
  assert.ok(match, '读取实际候选检测函数');
  const detect = vm.runInNewContext(`(${match[0].trim()})`);
  const local = { id: 'l', type: 'local-candidate', candidateType: 'host' };
  const remote = { id: 'r', type: 'remote-candidate', candidateType: 'srflx' };
  const pair = { id: 'p', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'l', remoteCandidateId: 'r' };
  const transport = { id: 't', type: 'transport', selectedCandidatePairId: 'p' };
  const check = (name, rows, expected) => {
    assert.equal(detect(new Map(rows.map((r) => [r.id, r]))).connectionType, expected, name);
    console.log(`PASS ${name}`);
  };
  check('无统计', [], 'unknown');
  check('标准已选直连', [local, remote, pair, transport], 'direct');
  check('本端中继', [{ ...local, candidateType: 'relay' }, remote, pair, transport], 'relay');
  check('远端中继', [local, { ...remote, candidateType: 'relay' }, pair, transport], 'relay');
  check('缺少远端候选', [local, pair, transport], 'unknown');
  check('缺少类型', [local, { ...remote, candidateType: undefined }, pair, transport], 'unknown');
  check('单端明确中继即可', [{ ...local, candidateType: 'relay' }, pair, transport], 'relay');
  check('历史流量不能判定', [local, remote, { ...pair, bytesReceived: 9999 }], 'unknown');
  check('selected兼容', [local, remote, { ...pair, selected: true }], 'direct');
  check('nominated成功兼容', [local, remote, { ...pair, nominated: true }], 'direct');
  check('nominated未成功', [local, remote, { ...pair, nominated: true, state: 'in-progress' }], 'unknown');
  check('多个nominated不猜测', [local, remote, { ...pair, nominated: true }, { ...pair, id: 'old', nominated: true }], 'unknown');
  check('transport优先于历史selected', [local, remote, pair, transport, { ...pair, id: 'old', selected: true, localCandidateId: 'relay' }, { ...local, id: 'relay', candidateType: 'relay' }], 'direct');
  check('transport缺失引用不退回历史', [local, remote, { ...pair, id: 'old', nominated: true }, transport], 'unknown');
  check('已选候选失败', [local, remote, { ...pair, state: 'failed' }, transport], 'unknown');
  check('多transport路径不一致不猜测', [local, remote, pair, transport, { ...transport, id: 't2', selectedCandidatePairId: 'other' }], 'unknown');

  const studio = fs.readFileSync(path.join(__dirname, '../public/studio.js'), 'utf8');
  const extract = (name) => {
    const fn = studio.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}\\n`));
    assert.ok(fn, `读取实际函数 ${name}`);
    return fn[0];
  };
  const pc = { connectionState: 'connected', __tier: 'mid' };
  const context = vm.createContext({
    peers: new Map([['viewer', pc]]), live: true,
    el: { stConnections: { textContent: '' } },
    TIER_RANK: { low: 0, mid: 1, high: 2 }, tunePeer: () => {}
  });
  vm.runInContext(['paintConnections', 'tierFor', 'applyViewerStats'].map(extract).join('\n'), context);
  for (const [stats, expected] of [
    [{ relay: true }, 'relay'], [{ relay: false }, 'unknown'],
    [{ connectionType: 'direct' }, 'direct'], [{ connectionType: 'relay' }, 'relay'],
    [{ connectionType: 'unknown' }, 'unknown']
  ]) {
    context.stats = stats;
    vm.runInContext("applyViewerStats('viewer', stats)", context);
    assert.equal(pc.__connectionType, expected);
  }
  assert.equal(vm.runInContext("tierFor({ connectionType: 'relay' })", context), 'mid');
  assert.equal(vm.runInContext('tierFor({ relay: true })', context), 'mid');
  pc.connectionState = 'disconnected';
  pc.__connectionType = 'relay';
  vm.runInContext("applyViewerStats('viewer', { connectionType: 'direct' }); paintConnections()", context);
  assert.equal(pc.__connectionType, 'relay', '断线后忽略延迟统计');
  assert.equal(context.el.stConnections.textContent, 'P2P 0路 / TURN 0路 / 检测中0路');
  console.log('PASS 主播新旧统计兼容、中继限速及断线排除');
}

testSelectedLink();

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
    if (window.__missingStats) return new Map();
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

if (!process.argv.includes('--offline')) (async () => {
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
      connection: document.querySelector('[data-connection-type]').textContent,
      title: document.querySelector('[data-connection-type]').title,
      ariaLive: document.querySelector('[data-connection-type]').getAttribute('aria-live'),
      playing: document.querySelector('[data-player]').classList.contains('is-playing'),
      tracks: s ? s.getTracks().filter(t => t.readyState === 'live').length : 0
    };
  })()`);

  out.hostStatus = await host.evaluate(`(() => ({
    connections: document.querySelector('[data-st-connections]').textContent,
    bitrate: (document.querySelector('[data-st-bitrate]') || {}).textContent,
    viewers: (document.querySelector('[data-st-viewers]') || {}).textContent
  }))()`);
  await viewer.evaluate('window.__missingStats = true');
  await sleep(4000);
  out.missingStats = {
    viewer: await viewer.evaluate(`document.querySelector('[data-connection-type]').textContent`),
    host: await host.evaluate(`document.querySelector('[data-st-connections]').textContent`)
  };
  await host.evaluate(`document.querySelector('[data-go-live]').click()`);
  await sleep(2000);
  out.stopped = {
    viewer: await viewer.evaluate(`document.querySelector('[data-connection-type]').textContent`),
    host: await host.evaluate(`document.querySelector('[data-st-connections]').textContent`)
  };
  out.errors = { host: host.errors, viewer: viewer.errors };
  console.log(JSON.stringify(out, null, 2));

  host.ws.close();
  viewer.ws.close();
  child.kill();
  await sleep(300);

  const bar = out.hostStatus.bitrate || '';
  const ok = out.viewer.playing
    && out.viewer.tracks === 2
    && out.viewer.connection === 'TURN中继'
    && out.viewer.title.includes('媒体经过 TURN')
    && out.viewer.ariaLive === 'polite'
    && out.hostStatus.connections === 'P2P 0路 / TURN 1路 / 检测中0路'
    && out.missingStats.viewer === '检测中'
    && out.missingStats.host === 'P2P 0路 / TURN 0路 / 检测中1路'
    && out.stopped.viewer === '未连接'
    && out.stopped.host === 'P2P 0路 / TURN 0路 / 检测中0路'
    && bar.includes('1 路中继')
    && bar.includes('1 路降档')
    && !out.errors.host.length && !out.errors.viewer.length;
  if (!ok) process.exitCode = 1;
})();
