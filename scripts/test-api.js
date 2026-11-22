'use strict';

/**
 * 服务端回归测试（零依赖）：鉴权 / 信令方向 / 断线宽限 / 聊天限速
 * 用法：node scripts/test-api.js
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 4901;
const KEY = 'test-secret';
const GRACE = 1200;

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`);
}

function req(method, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path: pathname,
        headers: Object.assign(
          data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
          headers || {}
        )
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch (err) { /* 非 JSON */ }
          resolve({ status: res.statusCode, body: json, raw: buf });
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/* 建立 SSE 连接，收集事件 */
function sse(query) {
  return new Promise((resolve, reject) => {
    const events = [];
    const r = http.request({ host: '127.0.0.1', port: PORT, path: `/api/events?${query}`, headers: { Accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: b, events, close() {} }));
        return;
      }
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = /event: (.+)/.exec(frame);
          const dt = /data: (.+)/.exec(frame);
          if (ev && dt) {
            let payload = null;
            try { payload = JSON.parse(dt[1]); } catch (err) { payload = dt[1]; }
            events.push({ event: ev[1], data: payload });
          }
        }
      });
      resolve({
        status: 200,
        events,
        close() { try { r.destroy(); } catch (err) { /* noop */ } },
        waitFor(name, ms) {
          return new Promise((res2) => {
            const t0 = Date.now();
            const tick = () => {
              const hit = events.find((e) => e.event === name);
              if (hit) return res2(hit);
              if (Date.now() - t0 > (ms || 3000)) return res2(null);
              setTimeout(tick, 40);
            };
            tick();
          });
        }
      });
    });
    r.on('error', reject);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), STREAM_KEY: KEY, HOST_GRACE_MS: String(GRACE) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let boot = '';
  child.stdout.on('data', (c) => { boot += c; });
  child.stderr.on('data', (c) => { boot += c; });

  try {
    for (let i = 0; i < 40; i += 1) {
      try { await req('GET', '/api/state'); break; } catch (err) { await sleep(120); }
    }

    // ---- 1. 配置与口令 ----
    const cfg = await req('GET', '/api/config');
    check('GET /api/config 报告需要口令', cfg.status === 200 && cfg.body.requireKey === true);
    check('GET /api/config 不泄露口令', !JSON.stringify(cfg.body).includes(KEY));

    const badAuth = await req('GET', '/api/auth?key=nope');
    check('错误口令 → 401', badAuth.status === 401);
    const goodAuth = await req('GET', `/api/auth?key=${KEY}`);
    check('正确口令 → 200', goodAuth.status === 200 && goodAuth.body.ok === true);

    // ---- 2. host 身份 ----
    const noKey = await sse('role=host&id=h0&name=Luma');
    check('无口令连 host SSE → 401', noKey.status === 401);

    const host = await sse(`role=host&id=host1&name=Luma&key=${KEY}`);
    const welcome = await host.waitFor('welcome');
    check('带口令连 host SSE → welcome', host.status === 200 && !!welcome);

    const viewer = await sse('role=viewer&id=v1&name=%E9%98%BF%E6%98%8E');
    const vWelcome = await viewer.waitFor('welcome');
    check('观众无需口令', viewer.status === 200 && !!vWelcome);
    check('观众收到 history', !!(await viewer.waitFor('history')));

    // ---- 3. 信令方向 ----
    const v2h = await req('POST', '/api/signal', { from: 'v1', to: 'host1', data: { candidate: { candidate: 'x' } } });
    check('观众 → 主播 允许', v2h.status === 200 && v2h.body.delivered === true);

    const h2v = await req('POST', '/api/signal', { from: 'host1', to: 'v1', data: { sdp: { type: 'offer', sdp: 'x' } } });
    check('主播 → 观众 允许', h2v.status === 200 && h2v.body.delivered === true);

    const spoof = await req('POST', '/api/signal', { from: 'ghost', to: 'v1', data: { candidate: {} } });
    check('伪造 from → 403', spoof.status === 403);

    const v3 = await sse('role=viewer&id=v2&name=%E5%B0%8F%E7%BA%A2');
    await v3.waitFor('welcome');
    const v2v = await req('POST', '/api/signal', { from: 'v1', to: 'v2', data: { candidate: {} } });
    check('观众 ↔ 观众 → 403', v2v.status === 403);

    // 服务端覆盖 from：用 v1 的连接发，但 body.from 写 host1，应被拒（因为 v1 是 viewer，目标是 v2 viewer）
    const forgedDirection = await req('POST', '/api/signal', { from: 'v1', to: 'v2', data: { candidate: {} } });
    check('伪造方向无法绕过', forgedDirection.status === 403);

    // ---- 4. 开播与口令 ----
    const noKeyStream = await req('POST', '/api/stream', { id: 'host1', live: true });
    check('开播不带口令 → 401', noKeyStream.status === 401);

    const goLive = await req('POST', '/api/stream', { id: 'host1', live: true, key: KEY, title: '测试场' });
    check('开播带口令 → 200 且 live', goLive.status === 200 && goLive.body.live === true);

    const goLiveEvt = await viewer.waitFor('go-live');
    check('观众收到 go-live', !!goLiveEvt);

    // ---- 5. 聊天：按连接限速 + 角色由服务端认定 ----
    const c1 = await req('POST', '/api/chat', { clientId: 'v1', name: '阿明', text: '第一条' });
    check('聊天发送成功', c1.status === 200);
    const c2 = await req('POST', '/api/chat', { clientId: 'v1', name: '换个名字', text: '第二条' });
    check('换昵称绕不过限速 → 429', c2.status === 429);
    const chatEvt = await viewer.waitFor('chat');
    check('聊天带正确角色', chatEvt && chatEvt.data.role === 'viewer', chatEvt ? chatEvt.data.name : '');
    const c3 = await req('POST', '/api/chat', { clientId: 'v1', name: '冒充主播', text: '我是主播', role: 'host' });
    check('观众自称主播无效', c3.status === 429 || (c3.body && c3.body.msg && c3.body.msg.role === 'viewer'));

    // ---- 6. 主播断线宽限 ----
    host.close();
    await sleep(300);
    const st = await req('GET', '/api/state');
    check('断线瞬间仍 live', st.body.live === true);
    check('断线瞬间标记 hostReconnecting', st.body.hostReconnecting === true);
    check('断线瞬间 hostOnline=false', st.body.hostOnline === false);
    check('观众没有收到 stream-ended', !viewer.events.some((e) => e.event === 'stream-ended'));

    // 宽限期内回来
    const host2 = await sse(`role=host&id=host1&name=Luma&key=${KEY}`);
    await host2.waitFor('welcome');
    await sleep(GRACE + 400);
    const st2 = await req('GET', '/api/state');
    check('宽限期内重连 → 直播继续', st2.body.live === true);
    check('重连后清除 reconnecting', st2.body.hostReconnecting === false);

    // 真掉线：不回来
    host2.close();
    await sleep(GRACE + 700);
    const st3 = await req('GET', '/api/state');
    check('超过宽限 → 直播结束', st3.body.live === false);
    check('观众收到 stream-ended', !!(await viewer.waitFor('stream-ended')));

    // ---- 7. 静态资源 ----
    const home = await req('GET', '/');
    check('首页 200', home.status === 200);
    const studio = await req('GET', '/studio');
    check('开播台 200', studio.status === 200);

    viewer.close();
    v3.close();
  } finally {
    child.kill();
    await sleep(200);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) {
      console.log('失败项：' + failed.map((f) => f.name).join(' | '));
      process.exitCode = 1;
    }
  }
})();
