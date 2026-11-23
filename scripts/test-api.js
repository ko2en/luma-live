'use strict';

/**
 * 服务端回归测试（零依赖）：鉴权 / 口令限速 / 信令方向 / 断线宽限 / 聊天限速 / ICE 下发
 * 用法：node scripts/test-api.js
 */

const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 4901;
const KEY = 'test-secret';
const GRACE = 1200;
const LOCK_MS = 1500;      // 测试里把锁定时长压短，便于验证「到点自动恢复」
const MAX_FAILS = 5;

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`);
}

const cookies = new Map();
function rememberCookie(res, port) {
  const cookie = res.headers['set-cookie'];
  if (cookie) cookies.set(port || PORT, cookie.map((s) => s.split(';')[0]).join('; '));
}

function req(method, pathname, body, headers, port) {
  return new Promise((resolve, reject) => {
    const data = method === 'POST' && body !== undefined ? JSON.stringify(body) : null;
    const r = http.request(
      {
        host: '127.0.0.1',
        port: port || PORT,
        method,
        path: pathname,
        headers: Object.assign(
          { Cookie: cookies.get(port || PORT) || '' },
          data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
          headers || {}
        )
      },
      (res) => {
        rememberCookie(res, port);
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch (err) { /* 非 JSON */ }
          resolve({ status: res.statusCode, body: json, raw: buf, headers: res.headers });
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/* 建立 SSE 连接，收集事件 */
/* 口令模式不再允许把 key 拼进 SSE URL：先换成一次性票据 */
function sseTicket(id, role = 'host', key = KEY, headers, port) {
  return req('POST', '/api/sse-ticket', { role, id, key }, headers, port)
    .then((r) => ({ status: r.status, ticket: (r.body && r.body.ticket) || '', body: r.body, headers: r.headers }));
}

function sse(query, port, cookie) {
  return new Promise((resolve, reject) => {
    const events = [];
    const r = http.request({
      host: '127.0.0.1',
      port: port || PORT,
      path: `/api/events?${query}`,
      headers: { Accept: 'text/event-stream', Cookie: cookie === undefined ? (cookies.get(port || PORT) || '') : cookie }
    }, (res) => {
      if (cookie === undefined) rememberCookie(res, port);
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

function spawnServer(env, port) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, env),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let boot = '';
  child.stdout.on('data', (c) => { boot += c; });
  child.stderr.on('data', (c) => { boot += c; });
  return {
    child,
    boot: () => boot,
    async ready() {
      for (let i = 0; i < 40; i += 1) {
        try { await req('GET', '/api/state', null, null, port); return true; } catch (err) { await sleep(120); }
      }
      return false;
    }
  };
}

/* ------------------------------------------------------------------ *
 * TURN 下发：单独起一台带 TURN_* 的服务，验证签名与三通道
 * ------------------------------------------------------------------ */
async function testTurn() {
  /* 用一个不太可能被占用的端口：4902/4903 是 test-studio-key / test-e2e 的默认端口，
     端口被占时这台服务会起不来，下面的日志断言会直接判失败，不会静默通过。 */
  const port = PORT + 10;
  const secret = 'turn-test-secret';
  const host = 'turn.example.com';
  const srv = spawnServer({
    PORT: String(port),
    STREAM_KEY: '',
    HOST_GRACE_MS: '0',
    TURN_HOST: host,
    TURN_PORT: '3478',
    TURN_TLS_PORT: '5349',
    TURN_STATIC_AUTH_SECRET: secret
  }, port);

  try {
    if (!await srv.ready()) {
      check('TURN 服务启动', false, srv.boot().slice(0, 200));
      return;
    }
    check('TURN 服务启动', srv.boot().includes('TURN 线路'), srv.boot().includes('EADDRINUSE') ? '端口被占用' : '');

    const viewer = await sse('role=viewer&id=t1&name=probe', port);
    const welcome = await viewer.waitFor('welcome');
    const ice = welcome && welcome.data && welcome.data.ice;
    check('welcome 里带 ice 配置', !!(ice && Array.isArray(ice.iceServers)));

    const flat = JSON.stringify(ice || {});
    check('下发 UDP 通道', flat.includes('turn:turn.example.com:3478?transport=udp'));
    check('下发 TCP 通道', flat.includes('turn:turn.example.com:3478?transport=tcp'));
    check('TURN_HOST 不再额外作为 STUN', !flat.includes('stun:turn.example.com:3478'));

    const turnEntry = (ice && ice.iceServers || []).find((s) => String(s.urls).includes('turn:'));
    check('TURN 带凭证', !!(turnEntry && turnEntry.username && turnEntry.credential));

    const username = turnEntry && turnEntry.username;
    const cm = /^(\d+):luma$/.exec(username || '');
    check('username 是「过期时间戳:用户名」', !!cm, username);
    if (cm) {
      const left = Number(cm[1]) - Math.floor(Date.now() / 1000);
      check('有效期约 6 小时', left > 6 * 3600 - 60 && left <= 6 * 3600, `${left}s`);
      const expect = crypto.createHmac('sha1', secret).update(username).digest('base64');
      check('credential 与 HMAC-SHA1 一致', turnEntry.credential === expect);
    }
    check('凭证不进客户端可见的其它字段', !flat.includes(secret));
    const zgTicket = await sseTicket('zero-grace', 'host', KEY, undefined, port);
    const hostConn = await sse(`role=host&id=zero-grace&ticket=${zgTicket.ticket}`, port);
    await hostConn.waitFor('welcome');
    await req('POST', '/api/stream', { id: 'zero-grace', live: true }, null, port);
    hostConn.close();
    const ended = await viewer.waitFor('stream-ended');
    const state = await req('GET', '/api/state', undefined, null, port);
    check('零宽限主播断线立即结束', !!ended && state.body.live === false && state.body.hostReconnecting === false);
    viewer.close();
  } finally {
    srv.child.kill();
    await sleep(200);
  }
}

(async () => {
  const srv = spawnServer({
    PORT: String(PORT),
    STREAM_KEY: KEY,
    HOST_GRACE_MS: String(GRACE),
    AUTH_LOCK_MS: String(LOCK_MS),
    AUTH_MAX_FAILS: String(MAX_FAILS),
    /* 保证测试不受开发机环境影响：这一台明确不配 TURN */
    TURN_HOST: '',
    TURN_PORT: '',
    TURN_TLS_PORT: '',
    TURN_STATIC_AUTH_SECRET: ''
  }, PORT);

  try {
    if (!await srv.ready()) throw new Error(`服务未启动\n${srv.boot()}`);

    // ---- 1. 配置与口令 ----
    const cfg = await req('GET', '/api/config');
    check('GET /api/config 报告需要口令', cfg.status === 200 && cfg.body.requireKey === true);
    check('GET /api/config 不泄露口令', !JSON.stringify(cfg.body).includes(KEY));

    /* 口令通道硬化：GET 不再接受口令，避免口令进反代访问日志 */
    const getAuth = await req('GET', `/api/auth?key=${KEY}`);
    check('GET /api/auth → 405（不再有 query 入口）', getAuth.status === 405, `Allow=${getAuth.headers.allow || '-'}`);
    check('405 带 Allow: POST', String(getAuth.headers.allow || '').toUpperCase().includes('POST'));

    const badAuth = await req('POST', '/api/auth', { key: 'nope' });
    check('错误口令 → 401', badAuth.status === 401);
    const goodAuth = await req('POST', '/api/auth', { key: KEY });
    check('正确口令 → 200', goodAuth.status === 200 && goodAuth.body.ok === true);

    // ---- 2. 未配 TURN 时 ICE 与以前一致 ----
    const probe = await sse('role=viewer&id=p0&name=probe');
    const pWelcome = await probe.waitFor('welcome');
    const pIce = pWelcome && pWelcome.data && pWelcome.data.ice;
    check('welcome 里带 ice 配置', !!(pIce && Array.isArray(pIce.iceServers)));
    const pFlat = JSON.stringify(pIce || {});
    check('未配 TURN 时只有默认 STUN', !pFlat.includes('"turn:') && !pFlat.includes('"turns:'));
    check('默认 STUN 已移除（固定 TURN）', !pFlat.includes('stun.l.google.com:19302'));
    probe.close();

    // ---- 3. host 身份 ----
    const noKey = await sse('role=host&id=h0&name=Luma');
    check('无口令连 host SSE → 401', noKey.status === 401);

    const hostTicket = await sseTicket('host1');
    check('口令换票成功', hostTicket.status === 200 && Boolean(hostTicket.ticket));
    const host = await sse(`role=host&id=host1&name=Luma&ticket=${hostTicket.ticket}`);
    const welcome = await host.waitFor('welcome');
    check('带口令连 host SSE → welcome', host.status === 200 && !!welcome);
    check('host 也收到 ice 配置', !!(welcome && welcome.data && welcome.data.ice));

    /* 票据一次性：同一张票不能再用第二次 */
    const replay = await sse(`role=host&id=hostT&name=Luma&ticket=${hostTicket.ticket}`);
    check('票据用过即废', replay.status === 401, `status=${replay.status}`);

    /* 老写法（口令进 URL）必须被拒，否则口令会留在反代日志里 */
    const legacyKey = await sse(`role=host&id=hostK&name=Luma&key=${KEY}`);
    check('URL 里带口令 → 401 ticket-required',
      legacyKey.status === 401 && String(legacyKey.body || '').includes('ticket-required'),
      `status=${legacyKey.status}`);
    const badTicket = await sse('role=host&id=hostB&name=Luma&ticket=not-a-ticket');
    check('伪造票据 → 401', badTicket.status === 401);

    /* 票据绑定 role + id：拿去喂别的身份必须无效 */
    const viewerTicket = await sseTicket('hRole', 'viewer');
    const wrongRole = await sse(`role=host&id=hRole&ticket=${viewerTicket.ticket}`);
    check('票据角色不匹配 → 401', wrongRole.status === 401, `status=${wrongRole.status}`);
    const idTicket = await sseTicket('hIdA');
    const wrongId = await sse(`role=host&id=hIdB&ticket=${idTicket.ticket}`);
    check('票据 id 不匹配 → 401', wrongId.status === 401, `status=${wrongId.status}`);

    const viewer = await sse('role=viewer&id=v1&name=%E9%98%BF%E6%98%8E');
    const vWelcome = await viewer.waitFor('welcome');
    check('观众无需口令', viewer.status === 200 && !!vWelcome);
    check('观众收到 history', !!(await viewer.waitFor('history')));

    const browserCookie = cookies.get(PORT);
    const outsider = await req('GET', '/api/config', undefined, { Cookie: '' });
    const outsiderCookie = cookies.get(PORT);
    cookies.set(PORT, browserCookie);
    check('会话 Cookie 为随机且 HttpOnly/SameSite=Strict', outsiderCookie !== browserCookie && /HttpOnly/.test(outsider.headers['set-cookie'][0]) && /SameSite=Strict/.test(outsider.headers['set-cookie'][0]));
    const forgedSignal = await req('POST', '/api/signal', { from: 'host1', to: 'v1', data: { sdp: {} } }, { Cookie: outsiderCookie });
    check('不同会话冒用真实 host id 发信令 → 403', forgedSignal.status === 403);
    const forgedChat = await req('POST', '/api/chat', { clientId: 'host1', text: '冒充主播' }, { Cookie: outsiderCookie });
    check('不同会话冒用真实 host id 聊天 → 403', forgedChat.status === 403);
    const forgedStream = await req('POST', '/api/stream', { id: 'host1', key: KEY, live: true }, { Cookie: outsiderCookie });
    check('不同会话持正确口令冒用 host 操作 → 403', forgedStream.status === 403);
    const forgedTicket = await sseTicket('host1');
    const forgedSse = await sse(`role=host&id=host1&ticket=${forgedTicket.ticket}`, PORT, outsiderCookie);
    check('不同会话替换真实 host SSE → 409', forgedSse.status === 409);
    const changedRole = await sse('role=viewer&id=host1');
    check('相同会话改变在线 id 角色 → 409', changedRole.status === 409);
    const original = await sse('role=viewer&id=reconnect&name=probe');
    const replacement = await sse('role=viewer&id=reconnect&name=probe');
    check('相同会话同角色 SSE 重连成功', original.status === 200 && replacement.status === 200);
    original.close();
    replacement.close();

    // ---- 4. 信令方向 ----
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

    // 同角色方向仍被拒绝；真实在线 id 的跨会话冒用已在前面单独覆盖。
    const forgedDirection = await req('POST', '/api/signal', { from: 'v1', to: 'v2', data: { candidate: {} } });
    check('伪造方向无法绕过', forgedDirection.status === 403);

    // ---- 5. 开播与口令 ----
    const noKeyStream = await req('POST', '/api/stream', { id: 'host1', live: true });
    check('开播不带口令 → 401', noKeyStream.status === 401);

    const goLive = await req('POST', '/api/stream', { id: 'host1', live: true, key: KEY, title: '测试场' });
    check('开播带口令 → 200 且 live', goLive.status === 200 && goLive.body.live === true);

    const goLiveEvt = await viewer.waitFor('go-live');
    check('观众收到 go-live', !!goLiveEvt);

    // ---- 6. 聊天：按连接限速 + 角色由服务端认定 ----
    const c1 = await req('POST', '/api/chat', { clientId: 'v1', name: '阿明', text: '第一条' });
    check('聊天发送成功', c1.status === 200);
    const c2 = await req('POST', '/api/chat', { clientId: 'v1', name: '换个名字', text: '第二条' });
    check('换昵称绕不过限速 → 429', c2.status === 429);
    const chatEvt = await viewer.waitFor('chat');
    check('聊天带正确角色', chatEvt && chatEvt.data.role === 'viewer', chatEvt ? chatEvt.data.name : '');
    const c3 = await req('POST', '/api/chat', { clientId: 'v1', name: '冒充主播', text: '我是主播', role: 'host' });
    check('观众自称主播无效', c3.status === 429 || (c3.body && c3.body.msg && c3.body.msg.role === 'viewer'));

    // ---- 7. 主播断线宽限 ----
    host.close();
    await sleep(300);
    const st = await req('GET', '/api/state');
    check('断线瞬间仍 live', st.body.live === true);
    check('断线瞬间标记 hostReconnecting', st.body.hostReconnecting === true);
    check('断线瞬间 hostOnline=false', st.body.hostOnline === false);
    check('观众没有收到 stream-ended', !viewer.events.some((e) => e.event === 'stream-ended'));

    // 宽限期内回来
    const host2Ticket = await sseTicket('host1');
    const host2 = await sse(`role=host&id=host1&name=Luma&ticket=${host2Ticket.ticket}`);
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

    // ---- 8. 静态资源 ----
    const home = await req('GET', '/');
    check('首页 200', home.status === 200);
    const studio = await req('GET', '/studio');
    check('开播台 200', studio.status === 200);

    check('响应带 nosniff', home.headers['x-content-type-options'] === 'nosniff');
    check('响应禁止 Referrer 泄露', home.headers['referrer-policy'] === 'no-referrer');
    const malformed = await req('GET', '/%E0%A4%A');
    check('畸形 URI → 400 且进程存活', malformed.status === 400 && (await req('GET', '/api/state')).status === 200);
    const badHost = await req('GET', '/', undefined, { Host: '[' });
    check('畸形 URL Host → 400', badHost.status === 400);
    const traversal = await req('GET', '/%2e%2e%5cserver.js');
    check('编码路径不能越界读取', traversal.status === 403 || traversal.status === 404);
    for (const route of ['/api/auth', '/api/signal', '/api/chat', '/api/stream']) {
      const invalid = await req('POST', route, null);
      check(`${route} 的 null JSON → 400`, invalid.status === 400);
    }
    for (const body of [[], 'text', 7, true]) {
      check(`非对象 JSON ${JSON.stringify(body)} → 400`, (await req('POST', '/api/chat', body)).status === 400);
    }
    const anonymous = await req('POST', '/api/chat', { text: '匿名仍兼容', role: 'host' });
    check('无 id 匿名聊天兼容且不能指定主播身份', anonymous.status === 200 && anonymous.body.msg.role === 'viewer');

    // ---- 9. TURN 下发（另起一台带 TURN_* 的服务） ----
    await testTurn();
    await testLines();
    await testDynamicHostLines();

    // ---- 10. 口令尝试限速（放最后：会把自己锁住） ----
    await req('POST', '/api/auth', { key: KEY }); // 先清零计数

    let firstStatus = null;
    for (let i = 1; i <= MAX_FAILS; i += 1) {
      const r = await req('POST', '/api/auth', { key: `wrong-${i}` });
      if (i === 1) firstStatus = r.status;
      if (i === MAX_FAILS) check('第 5 次失败仍是 401（还没锁）', r.status === 401, `第 ${i} 次 ${r.status}`);
    }
    check('首次失败 401', firstStatus === 401);

    const locked = await req('POST', '/api/auth', { key: 'wrong-again' });
    check('第 6 次 → 429', locked.status === 429);
    check('429 带 Retry-After', Number(locked.headers['retry-after']) > 0, `Retry-After=${locked.headers['retry-after']}`);

    const lockedGood = await req('POST', '/api/auth', { key: KEY });
    check('锁定期间连正确口令也 429', lockedGood.status === 429);

    const lockedTicket = await sseTicket('hl');
    check('锁定期间换票也拒', lockedTicket.status === 429);

    await sleep(LOCK_MS + 400);
    for (let i = 1; i <= MAX_FAILS; i += 1) {
      const retried = await req('POST', '/api/auth', { key: `retry-${i}` });
      check(`锁定到期后第 ${i} 次错误仍允许尝试`, retried.status === 401);
    }
    const lockedAgain = await req('POST', '/api/auth', { key: KEY });
    check('新一轮第 6 次才再次锁定', lockedAgain.status === 429);
    await sleep(LOCK_MS + 200);
    const recovered = await req('POST', '/api/auth', { key: KEY });
    check('锁定期满 → 恢复 200', recovered.status === 200);

    // ---- 11. scrypt 参数边界（不经过 HTTP，直接测模块） ----
    const pw = require('../src/password');
    const salt = 'a'.repeat(32);
    const hash = 'b'.repeat(64);
    const badCreds = [
      ['N 不是 2 的幂', `scrypt:100000:8:1:${salt}:${hash}`],
      ['N 过大', `scrypt:1048576:8:1:${salt}:${hash}`],
      ['r 过大', `scrypt:16384:64:1:${salt}:${hash}`],
      ['p 过大', `scrypt:16384:8:9:${salt}:${hash}`],
      ['hash 过短', `scrypt:16384:8:1:${salt}:bb`]
    ];
    for (const [label, cred] of badCreds) {
      const r = await pw.verifyCredential(cred, 'whatever');
      check(`异常 scrypt 参数（${label}）直接判失败`, r.ok === false);
    }
    const good = await pw.hashCredential('pass-123');
    check('自产 scrypt 摘要校验通过', (await pw.verifyCredential(good, 'pass-123')).ok === true);
    check('自产 scrypt 摘要拒绝错误密码', (await pw.verifyCredential(good, 'nope')).ok === false);

    viewer.close();
    v3.close();
  } finally {
    srv.child.kill();
    await sleep(200);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) {
      console.log('失败项：' + failed.map((f) => f.name).join(' | '));
      process.exitCode = 1;
    }
  }
})();

/* ------------------------------------------------------------------ *
 * 线路：TURN_LINES 定义可选线路，p2p 永远可选，turn= 决定本次下发哪条
 * ------------------------------------------------------------------ */
/* 起一台临时服务，取 welcome 里下发的 ice；turn 是本次要选的线路 */
async function iceOrder(env, port, turn, role) {
  const srv = spawnServer(Object.assign({
    PORT: String(port),
    STREAM_KEY: '',
    HOST_GRACE_MS: '0'
  }, env), port);
  let ice = null;
  let boot = '';
  try {
    if (!await srv.ready()) return { ice, boot: srv.boot() };
    boot = srv.boot();
    const turnQ = turn ? `&turn=${encodeURIComponent(turn)}` : '';
    /* host 身份要票据（这些子服务都没配口令，票据只是握手凭证） */
    let ticketQ = '';
    if ((role || 'viewer') === 'host') {
      const t = await sseTicket('probe', 'host', '', undefined, port);
      ticketQ = `&ticket=${t.ticket}`;
    }
    const viewer = await sse(`role=${role || 'viewer'}&id=probe&name=probe${turnQ}${ticketQ}`, port);
    const welcome = await viewer.waitFor('welcome');
    ice = welcome && welcome.data && welcome.data.ice;
    viewer.close();
  } finally {
    srv.child.kill();
    await sleep(150);
  }
  return { ice, boot };
}

function turnHosts(ice) {
  const hosts = [];
  for (const s of (ice && ice.iceServers) || []) {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    for (const u of urls) {
      const m = /^turns?:([^:?]+)/.exec(String(u) || '');
      if (m) hosts.push(m[1]);
    }
  }
  /* 每条线路会下发 udp / tcp 多条 url，按 host 去重 */
  return Array.from(new Set(hosts));
}

function lineIds(ice) {
  return ((ice && ice.lines) || []).map((l) => l.id);
}

async function testLines() {
  const lines = 'sh|203.0.113.20|23478|sh-secret|上海';
  const env = { TURN_LINES: lines, TURN_DEFAULT: 'sh' };

  /* 1. 默认线路 */
  const a = await iceOrder(env, PORT + 11);
  check('默认线路取 TURN_DEFAULT', !!(a.ice && a.ice.line === 'sh'), String(a.ice && a.ice.line));
  check('默认只下发这一条 TURN', turnHosts(a.ice).join(',') === '203.0.113.20', turnHosts(a.ice).join(','));
  check('线路清单固定上海', lineIds(a.ice).join(',') === 'sh', lineIds(a.ice).join(','));
  check('线路带标题与 host（供前端标注）',
    JSON.stringify(a.ice.lines).includes('上海') && JSON.stringify(a.ice.lines).includes('203.0.113.20'));
  check('启动日志列出线路', (a.boot || '').includes('TURN 线路') && (a.boot || '').includes('上海'), (a.boot || '').slice(-260));

  /* 2. 旧版客户端即使携带线路参数，也始终固定上海 */
  const b = await iceOrder(env, PORT + 12, 'hk');
  check('旧 turn=hk 仍固定上海', turnHosts(b.ice).join(',') === '203.0.113.20', turnHosts(b.ice).join(','));
  check('旧 turn=hk 不改变线路', !!(b.ice && b.ice.line === 'sh'), String(b.ice && b.ice.line));

  /* 3. 老变量仍然可用（TURN_HOST / TURN_LABEL） */
  const e = await iceOrder({
    TURN_HOST: 'hk.example.com',
    TURN_PORT: '3478',
    TURN_STATIC_AUTH_SECRET: 'main-secret',
    TURN_LABEL: '香港'
  }, PORT + 15);
  check('老变量 TURN_HOST 变成一条线路', !!(e.ice && e.ice.line === 'main'), String(e.ice && e.ice.line));
  check('TURN_LABEL 作为固定线路配置', turnHosts(e.ice).join(',') === 'hk.example.com');
  check('老变量只下发这一个 host', turnHosts(e.ice).join(',') === 'hk.example.com', turnHosts(e.ice).join(','));

  /* 4. 未配置 TURN 时保持无可用中继，客户端不能回退 P2P */
  const f = await iceOrder({}, PORT + 16);
  check('未配 TURN → 无线路', lineIds(f.ice).length === 0, lineIds(f.ice).join(','));
  check('未配 TURN → relay 策略', f.ice && f.ice.iceTransportPolicy === 'relay');

  /* 5. 固定上海始终强制 relay */
  const g = await iceOrder(env, PORT + 17, 'sh');
  check('固定上海 → iceTransportPolicy=relay', !!(g.ice && g.ice.iceTransportPolicy === 'relay'),
    String(g.ice && g.ice.iceTransportPolicy));

  /* 5.5 TURN_DEFAULT 指定哪条线路就下发哪条（多线路格式预留） */
  const two = 'hk|203.0.113.30|3478||香港,tokyo|203.0.113.40|3478||东京';
  const j = await iceOrder({ TURN_LINES: two, TURN_DEFAULT: 'tokyo' }, PORT + 21);
  check('TURN_DEFAULT 选中第二条线路', !!(j.ice && j.ice.line === 'tokyo'), String(j.ice && j.ice.line));
  check('只下发被选中那条的 TURN host', turnHosts(j.ice).join(',') === '203.0.113.40', turnHosts(j.ice).join(','));
  const k = await iceOrder({ TURN_LINES: two, TURN_DEFAULT: 'nowhere' }, PORT + 22);
  check('TURN_DEFAULT 写错时退回第一条', !!(k.ice && k.ice.line === 'hk'), String(k.ice && k.ice.line));

  /* 6. 主播与观众都使用同一上海 ICE 配置 */
  const i = await iceOrder(env, PORT + 19, '', 'host');
  check('主播端 welcome 的 ice 仍保留默认线路（兼容旧前端）',
    !!(i.ice && i.ice.line === 'sh') && turnHosts(i.ice).join(',') === '203.0.113.20',
    JSON.stringify({ line: i.ice && i.ice.line, hosts: turnHosts(i.ice) }));
  check('主播端使用固定上海 ICE',
    !!(i.ice && i.ice.iceTransportPolicy === 'relay' && turnHosts(i.ice).join(',') === '203.0.113.20'),
    JSON.stringify({ policy: i.ice && i.ice.iceTransportPolicy, hosts: turnHosts(i.ice) }));
}

/* 固定线路后，旧版 viewer 重新连接也不会触发线路切换事件。 */
async function testDynamicHostLines() {
  const port = PORT + 20;
  const srv = spawnServer({
    PORT: String(port),
    STREAM_KEY: '',
    HOST_GRACE_MS: '0',
    TURN_LINES: 'sh|203.0.113.20|23478|sh-secret|上海',
    TURN_DEFAULT: 'sh'
  }, port);
  let host = null;
  let v1 = null;
  let v2 = null;
  try {
    if (!await srv.ready()) return check('动态线路测试服务启动', false, srv.boot().slice(-200));
    const dhTicket = await sseTicket('dh', 'host', KEY, undefined, port);
    host = await sse(`role=host&id=dh&name=H&ticket=${dhTicket.ticket}`, port);
    await host.waitFor('welcome');
    const live = await req('POST', '/api/stream', { id: 'dh', live: true }, null, port);
    check('动态线路测试：开播成功', live.status === 200 && live.body.live === true);

    v1 = await sse('role=viewer&id=dv1&name=V&turn=sh', port);
    await v1.waitFor('welcome');
    const joined = await host.waitFor('viewer-joined');
    check('viewer-joined 带上观众当前线路', !!(joined && joined.data.line === 'sh'),
      joined ? JSON.stringify(joined.data) : 'no event');

    v2 = await sse('role=viewer&id=dv1&name=V&turn=p2p', port);
    await v2.waitFor('welcome');
    const switched = await host.waitFor('viewer-line');
    check('旧版切换参数仍固定上海', !!(switched === null || (switched && switched.data.line === 'sh')),
      switched ? JSON.stringify(switched.data) : 'no event');

    await req('POST', '/api/stream', { id: 'dh', live: true }, null, port);
    await sleep(150);
    const goEvt = host.events.filter((e) => e.event === 'go-live').pop();
    check('go-live 的观众列表带线路信息',
      !!(goEvt && Array.isArray(goEvt.data.viewers)
        && goEvt.data.viewers.some((v) => v.id === 'dv1' && v.line === 'sh')),
      goEvt ? JSON.stringify(goEvt.data.viewers) : 'no event');
  } finally {
    for (const c of [host, v1, v2]) { try { if (c) c.close(); } catch (err) { /* noop */ } }
    srv.child.kill();
    await sleep(150);
  }
}