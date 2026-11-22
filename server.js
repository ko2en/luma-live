'use strict';

/**
 * LUMA Live — 轻量自建直播间
 * 后端职责：静态托管 + SSE 事件流（聊天 / 状态 / WebRTC 信令）
 * 零依赖，单进程，单端口。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');

/* 开播口令：设了就必须带对才能占住 host 身份。
   不设则任何人打开 /studio 都能开播（只适合本机/内网自用）。 */
const STREAM_KEY = String(process.env.STREAM_KEY || '').trim();

/* 主播 SSE 掉线后的宽限期：媒体是 P2P 直连，SSE 断了画面还在，
   只要主播在宽限期内重连回来，这场直播就不该被判死。 */
const HOST_GRACE_MS = Math.max(0, Number(process.env.HOST_GRACE_MS || 10000));

const CHAT_MIN_INTERVAL = Math.max(0, Number(process.env.CHAT_MIN_INTERVAL || 350));
const CHAT_RATE_MAP_MAX = 1000;

/* ------------------------------------------------------------------ *
 * 内存状态（直播间是实时的，重启即清空，符合直播语义）
 * ------------------------------------------------------------------ */

const PALETTE = [
  '#a78bfa', '#f472b6', '#38bdf8', '#fbbf24', '#34d399',
  '#fb7185', '#c084fc', '#60a5fa', '#facc15', '#2dd4bf'
];

const clients = new Map(); // id -> { id, role, res, name, joinedAt }
const chatLog = [];        // 最近 120 条
let chatSeq = 0;
/* 限速键是「连接」，不是昵称：换昵称绕不过去，连接断开后由宽限期清扫 */
const lastChatAt = new Map();

const stream = {
  live: false,
  title: '在代码与夜色之间 · 独立开发的第 100 天',
  streamer: 'Luma',
  bio: '一个人做产品。今晚把直播间最后一块拼图补上，顺便聊聊为什么我不想把内容交给别人。',
  muted: { audio: false, video: false },
  startedAt: null,
  hostId: null
};

/* host 断线宽限期的运行态 */
let hostGraceTimer = null;
let hostGraceUntil = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function colorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/* 定时比较，避免逐字符短路泄漏口令长度/前缀 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch (err) { return false; }
}

function keyOk(candidate) {
  if (!STREAM_KEY) return true;
  return safeEqual(candidate, STREAM_KEY);
}

function clearHostGrace() {
  if (hostGraceTimer) {
    clearTimeout(hostGraceTimer);
    hostGraceTimer = null;
  }
  hostGraceUntil = 0;
}

/* 主播掉线：先不判死，给 10 秒重连窗口 */
function startHostGrace() {
  clearHostGrace();
  if (!HOST_GRACE_MS) return;
  hostGraceUntil = Date.now() + HOST_GRACE_MS;
  hostGraceTimer = setTimeout(() => {
    hostGraceTimer = null;
    hostGraceUntil = 0;
    if (stream.hostId || !stream.live) {
      broadcastState(true);
      return;
    }
    stream.live = false;
    stream.startedAt = null;
    broadcast('stream-ended', { reason: 'host-disconnected' });
    broadcastState(true);
  }, HOST_GRACE_MS);
  if (hostGraceTimer.unref) hostGraceTimer.unref();
}

function viewerCount() {
  let n = 0;
  for (const c of clients.values()) if (c.role === 'viewer') n++;
  return n;
}

function viewerIds() {
  const out = [];
  for (const c of clients.values()) if (c.role === 'viewer') out.push(c.id);
  return out;
}

function statePayload() {
  return {
    live: stream.live,
    title: stream.title,
    streamer: stream.streamer,
    bio: stream.bio,
    muted: stream.muted,
    startedAt: stream.startedAt,
    viewers: viewerCount(),
    hostOnline: Boolean(stream.hostId),
    /* 主播信令断了但还没过宽限期：观众端提示「正在重连」，不要直接判死 */
    hostReconnecting: hostGraceUntil > Date.now()
  };
}

function sendTo(id, event, data) {
  const c = clients.get(id);
  if (!c) return false;
  try {
    c.res.write(`event: ${event}\ndata: ${JSON.stringify(data === undefined ? {} : data)}\n\n`);
    return true;
  } catch (err) {
    return false;
  }
}

function broadcast(event, data, exceptId) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data === undefined ? {} : data)}\n\n`;
  for (const c of clients.values()) {
    if (c.id === exceptId) continue;
    try { c.res.write(frame); } catch (err) { /* noop */ }
  }
}

/* 状态广播做合并：观众成批涌入时（一次转发带来几十个新连接），
   每个连接都广播一次会变成 O(N²) 写入。这里把窗口内的多次请求
   合并成一帧，延迟 200ms 完全不影响观感。 */
let stateTimer = null;

function broadcastState(immediate) {
  if (immediate) {
    flushState();
    return;
  }
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    flushState();
  }, 200);
  if (stateTimer.unref) stateTimer.unref();
}

function flushState() {
  if (!clients.size) return;
  broadcast('state', statePayload());
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req, limit = 96 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ *
 * SSE
 * ------------------------------------------------------------------ */

/* 所有连接共用一个心跳定时器：N 个连接 N 个 timer 是纯浪费 */
let heartbeat = null;

function startHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const c of clients.values()) {
      try { c.res.write(': ping\n\n'); } catch (err) { /* noop */ }
    }
  }, 20000);
}

function handleEvents(req, res, url) {
  const id = (url.searchParams.get('id') || '').slice(0, 64);
  const role = url.searchParams.get('role') === 'host' ? 'host' : 'viewer';
  const name = (url.searchParams.get('name') || '访客').slice(0, 24);

  if (!id) return json(res, 400, { error: 'missing id' });

  /* host 身份必须凭口令取得，否则任何人都能抢走整个直播间 */
  if (role === 'host' && !keyOk(url.searchParams.get('key') || '')) {
    return json(res, 401, { error: '开播口令不正确' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (res.flushHeaders) res.flushHeaders();
  res.write(': connected\n\n');

  // 同一 id 重连：踢掉旧连接
  const previous = clients.get(id);
  if (previous) {
    try { previous.res.end(); } catch (err) { /* noop */ }
    clients.delete(id);
  }

  clients.set(id, { id, role, res, name, joinedAt: Date.now() });

  if (role === 'host') {
    // 换了一台设备/换了标签页开播：让旧的那个安静退场
    if (stream.hostId && stream.hostId !== id) {
      const stale = clients.get(stream.hostId);
      if (stale) {
        try { stale.res.end(); } catch (err) { /* noop */ }
        clients.delete(stream.hostId);
      }
    }
    stream.hostId = id;
    clearHostGrace(); // 宽限期内回来了 → 这场直播继续
  }

  // 首包
  sendTo(id, 'welcome', { id, role, ...statePayload() });
  sendTo(id, 'history', chatLog.slice(-80));
  if (role === 'viewer') {
    if (stream.live && stream.hostId && stream.hostId !== id) {
      sendTo(stream.hostId, 'viewer-joined', { id, name });
    }
  }

  broadcastState();

  startHeartbeat();

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;

    const current = clients.get(id);
    const isCurrent = Boolean(current && current.res === res);
    if (isCurrent) clients.delete(id);
    if (lastChatAt.has(id)) lastChatAt.delete(id);

    if (role === 'host') {
      /* 已经被同 id 的新连接顶替：这条旧连接的关闭与直播状态无关 */
      if (!isCurrent) return;
      if (stream.hostId === id) stream.hostId = null;
      if (stream.live) startHostGrace();
      else clearHostGrace();
      broadcastState();
      return;
    }

    if (isCurrent && stream.hostId) sendTo(stream.hostId, 'viewer-left', { id });
    broadcastState();
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
}

/* ------------------------------------------------------------------ *
 * 静态文件
 * ------------------------------------------------------------------ */

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === '/' || pathname === '/index.html') pathname = '/index.html';
  else if (pathname === '/studio' || pathname === '/studio/') pathname = '/studio.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(pathname).replace(/^(\.\.[\/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=120'
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (req.method === 'GET' && route === '/api/state') {
    return json(res, 200, statePayload());
  }

  /* 开播端启动时问一次：这台服务器要不要口令？
     只回答「要不要」，不泄露口令本身，也不需要鉴权。 */
  if (req.method === 'GET' && route === '/api/config') {
    return json(res, 200, {
      requireKey: Boolean(STREAM_KEY),
      hostGraceMs: HOST_GRACE_MS,
      chatMinInterval: CHAT_MIN_INTERVAL
    });
  }

  /* 校验口令（开播页在真正连 SSE 之前先问一句，便于给出明确提示） */
  if (req.method === 'GET' && route === '/api/auth') {
    if (!STREAM_KEY) return json(res, 200, { ok: true, requireKey: false });
    const ok = keyOk(url.searchParams.get('key') || '');
    return json(res, ok ? 200 : 401, ok ? { ok: true, requireKey: true } : { ok: false, error: '开播口令不正确' });
  }

  if (req.method === 'POST' && route === '/api/signal') {
    let body;
    try { body = await readBody(req); } catch (err) { return json(res, 400, { error: 'bad body' }); }
    const { from, to, data } = body || {};
    if (!from || !to || !data) return json(res, 400, { error: 'from/to/data required' });

    /* 不信任请求体里的 from：必须是当前真实在线的连接，
       from 由服务端认定后覆盖转发，伪造发信人这条路就断了。 */
    const fromId = String(from).slice(0, 64);
    const toId = String(to).slice(0, 64);
    const sender = clients.get(fromId);
    if (!sender) return json(res, 403, { error: 'sender not connected' });

    const target = clients.get(toId);
    if (!target) return json(res, 200, { delivered: false });

    /* 只允许 host ↔ viewer 两个方向：观众之间互发一律拒绝 */
    if (sender.role === target.role) {
      return json(res, 403, { error: 'signal direction not allowed' });
    }

    sendTo(toId, 'signal', { from: sender.id, data });
    return json(res, 200, { delivered: true });
  }

  if (req.method === 'POST' && route === '/api/chat') {
    let body;
    try { body = await readBody(req); } catch (err) { return json(res, 400, { error: 'bad body' }); }
    const rawName = String(body.name || '').trim() || '访客';
    const name = rawName.slice(0, 20);
    const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!text) return json(res, 400, { error: 'empty' });

    /* 身份以 SSE 连接为准：连着的就用连接上的角色和昵称，
       没连着的（直连 API）只按 IP 限速，且永远拿不到「主播」标签。 */
    const clientId = String(body.clientId || body.id || '').slice(0, 64);
    const conn = clientId ? clients.get(clientId) : null;
    const role = conn && conn.role === 'host' ? 'host' : 'viewer';
    const shownName = role === 'host' ? (conn.name || 'Luma') : name;

    const rateKey = conn ? `c:${conn.id}` : `ip:${req.socket.remoteAddress || '?'}`;
    const now = Date.now();
    if (now - (lastChatAt.get(rateKey) || 0) < CHAT_MIN_INTERVAL) {
      return json(res, 429, { error: 'too fast' });
    }
    lastChatAt.set(rateKey, now);

    /* Map 封顶，防止有人批量建连接把内存拖穿 */
    if (lastChatAt.size > CHAT_RATE_MAP_MAX) {
      for (const k of lastChatAt.keys()) {
        lastChatAt.delete(k);
        if (lastChatAt.size <= CHAT_RATE_MAP_MAX / 2) break;
      }
    }

    const msg = {
      id: `m${++chatSeq}`,
      name: shownName,
      text,
      color: colorFor(shownName),
      role,
      ts: now
    };
    chatLog.push(msg);
    if (chatLog.length > 120) chatLog.shift();
    broadcast('chat', msg);
    return json(res, 200, { ok: true, msg });
  }

  if (req.method === 'POST' && route === '/api/stream') {
    let body;
    try { body = await readBody(req); } catch (err) { return json(res, 400, { error: 'bad body' }); }

    if (STREAM_KEY && !keyOk(body.key || '')) {
      return json(res, 401, { error: '开播口令不正确' });
    }

    const id = String(body.id || '');
    if (!id || id !== stream.hostId) {
      return json(res, 403, { error: '只有已连接的开播端可以操作' });
    }

    if (typeof body.title === 'string' && body.title.trim()) {
      stream.title = body.title.trim().slice(0, 90);
    }
    if (body.muted && typeof body.muted === 'object') {
      stream.muted = {
        audio: Boolean(body.muted.audio),
        video: Boolean(body.muted.video)
      };
    }

    if (body.live === true) {
      clearHostGrace();
      if (!stream.live) {
        stream.live = true;
        stream.startedAt = Date.now();
      }
      broadcastState();
      broadcast('go-live');
      // 让开播端知道要给哪些观众发 offer
      sendTo(stream.hostId, 'go-live', { viewers: viewerIds() });
      return json(res, 200, statePayload());
    }

    if (body.live === false && stream.live) {
      stream.live = false;
      stream.startedAt = null;
      clearHostGrace();
      broadcastState();
      broadcast('stream-ended', { reason: 'host-stopped' });
      return json(res, 200, statePayload());
    }

    broadcastState();
    return json(res, 200, statePayload());
  }

  return json(res, 404, { error: 'not found' });
}

/* ------------------------------------------------------------------ *
 * server
 * ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/events') {
    return handleEvents(req, res, url);
  }
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: 'server error' });
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('method not allowed');
    return;
  }
  serveStatic(req, res, url);
});

server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 65000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`LUMA Live 已启动 → http://localhost:${PORT}`);
  console.log(`  观众页  http://localhost:${PORT}/`);
  console.log(`  开播端  http://localhost:${PORT}/studio`);
  if (STREAM_KEY) {
    console.log('  开播口令  已启用（STREAM_KEY），开播端需要输入口令');
  } else {
    console.log('  开播口令  未启用 —— 任何能打开 /studio 的人都可以开播。');
    console.log('            公网部署请设置环境变量 STREAM_KEY=你的口令');
  }
  if (HOST_GRACE_MS) console.log(`  断线宽限  ${HOST_GRACE_MS} ms（主播掉线后不立即结束直播）`);
});
