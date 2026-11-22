'use strict';

/* 用 CDP 驱动真实浏览器验证开播页口令流程（Node 22 自带 WebSocket） */
const { spawn } = require('child_process');
const http = require('http');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333;
const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:4902/studio';
const KEY = process.argv[3] || 'demo123';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const prof = 'C:/tmp/edge-cdp-prof';
  const child = spawn(EDGE, [
    '--headless', '--disable-gpu', '--no-sandbox',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`,
    URL_UNDER_TEST
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 60; i += 1) {
    try { targets = await getJson('/json/list'); if (targets && targets.length) break; } catch (e) { /* retry */ }
    await sleep(250);
  }
  const page = (targets || []).find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const logs = [];

  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception ? msg.params.exceptionDetails.exception.description : msg.params.exceptionDetails.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      logs.push(msg.params.args.map((a) => a.value || a.description).join(' '));
    }
  };

  const send = (method, params) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, { resolve });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r && r.exceptionDetails) return { error: r.exceptionDetails.text };
    return r && r.result ? r.result.value : undefined;
  };

  await send('Runtime.enable');
  await send('Page.enable');

  const state = () => evaluate(`(() => {
    const row = document.querySelector('[data-key-row]');
    const ks = document.querySelector('[data-key-state]');
    const btn = document.querySelector('[data-go-live]');
    return {
      keyRowHidden: row ? row.hidden : null,
      keyState: ks ? ks.textContent : null,
      keyStateKind: ks ? (ks.dataset.state || '') : null,
      inputValue: (document.querySelector('[data-key-input]') || {}).value,
      btn: btn ? btn.textContent : null,
      status: (document.querySelector('[data-st-status]') || {}).textContent,
      badge: (document.querySelector('[data-live-badge]') || {}).textContent,
      stored: localStorage.getItem('luma:key')
    };
  })()`);

  const out = {};
  out.beforeKey = await state();

  // 输入正确口令并回车
  await evaluate(`(() => {
    const i = document.querySelector('[data-key-input]');
    i.value = ${JSON.stringify(KEY)};
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(2500);
  out.afterKey = await state();

  // 再触发一次开播（真实浏览器里会真的采集假设备，然后 POST /api/stream）
  await evaluate(`document.querySelector('[data-go-live]').click()`);
  await sleep(2500);
  out.afterGoLive = await state();
  out.badgeHasOnAir = await evaluate(`document.querySelector('[data-live-badge]').textContent.includes('ON AIR')`);

  // 错误口令
  await evaluate(`localStorage.removeItem('luma:key')`);
  await send('Page.navigate', { url: URL_UNDER_TEST });
  await sleep(2500);
  await evaluate(`(() => {
    const i = document.querySelector('[data-key-input]');
    i.value = 'wrong-key';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(1200);
  out.wrongKey = await state();

  // 刷新后仍记得口令
  await evaluate(`localStorage.setItem('luma:key', ${JSON.stringify(KEY)})`);
  await send('Page.navigate', { url: URL_UNDER_TEST });
  await sleep(3000);
  out.afterReload = await state();

  out.errors = errors;
  out.consoleErrors = logs;
  console.log(JSON.stringify(out, null, 2));

  ws.close();
  child.kill();
  await sleep(200);
  const bad = errors.length > 0 || out.wrongKey.keyStateKind !== 'bad' ||
    out.afterKey.keyStateKind !== 'ok' || !out.badgeHasOnAir;
  process.exitCode = bad ? 1 : 0;
})();
