'use strict';

/**
 * LUMA Live — 轻量自建直播间
 * 后端职责：静态托管 + SSE 事件流（聊天 / 状态 / WebRTC 信令）
 * 零依赖，单进程，单端口。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');

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
    hostOnline: Boolean(stream.hostId)
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
    stream.hostId = id;
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

  const cleanup = () => {
    const current = clients.get(id);
    if (current && current.res === res) clients.delete(id);

    if (role === 'host' && stream.hostId === id) {
      stream.hostId = null;
      if (stream.live) {
        stream.live = false;
        stream.startedAt = null;
        broadcast('stream-ended', { reason: 'host-disconnected' });
      }
      broadcastState();
    } else {
      if (role === 'viewer' && stream.hostId) {
        sendTo(stream.hostId, 'viewer-left', { id });
      }
      broadcastState();
    }
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

  if (req.method === 'POST' && route === '/api/signal') {
    let body;
    try { body = await readBody(req); } catch (err) { return json(res, 400, { error: 'bad body' }); }
    const { from, to, data } = body || {};
    if (!from || !to || !data) return json(res, 400, { error: 'from/to/data required' });
    if (!clients.has(to)) return json(res, 200, { delivered: false });
    sendTo(to, 'signal', { from, data });
    return json(res, 200, { delivered: true });
  }

  if (req.method === 'POST' && route === '/api/chat') {
    let body;
    try { body = await readBody(req); } catch (err) { return json(res, 400, { error: 'bad body' }); }
    const rawName = String(body.name || '').trim() || '访客';
    const name = rawName.slice(0, 20);
    const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!text) return json(res, 400, { error: 'empty' });

    const now = Date.now();
    if (now - (lastChatAt.get(name) || 0) < 350) {
      return json(res, 429, { error: 'too fast' });
    }
    lastChatAt.set(name, now);

    const msg = {
      id: `m${++chatSeq}`,
      name,
      text,
      color: colorFor(name),
      role: body.role === 'host' ? 'host' : 'viewer',
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
});
