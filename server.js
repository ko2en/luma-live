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

/* 口令尝试限速：按来源 IP 计数，连续失败若干次锁一段时间。
   公网上的 /api/auth 和 host 的 SSE 连接都算一次尝试，防止离线爆破。 */
const AUTH_MAX_FAILS = Math.max(1, Number(process.env.AUTH_MAX_FAILS || 5));
const AUTH_LOCK_MS = Math.max(0, Number(process.env.AUTH_LOCK_MS || 60_000));
const AUTH_MAP_MAX = 1000;
/* 默认只认 socket 地址（伪造不了）。跑在 Caddy / Nginx / 平台反代后面时
   所有请求的来源都是代理本身，要设 TRUST_PROXY=1 才读 X-Forwarded-For。 */
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';

/* ---------------- TURN（全部可选，不配就完全走原来的 STUN 直连） ----------------
   TURN_HOST 一旦设置，welcome 事件里就会带上服务端生成的 iceServers，
   凭证按 coturn 的 REST API 方式（static-auth-secret）用 HMAC-SHA1 现签，
   有效期 6 小时。没有 TURN_STATIC_AUTH_SECRET 时退化成无凭证的匿名中继。 */
const TURN_HOST = String(process.env.TURN_HOST || '').trim();
const TURN_PORT = String(process.env.TURN_PORT || '3478').trim();
const TURN_TLS_PORT = String(process.env.TURN_TLS_PORT || '5349').trim();
const TURN_STATIC_AUTH_SECRET = String(process.env.TURN_STATIC_AUTH_SECRET || '').trim();
const TURN_TTL_SEC = 6 * 60 * 60;
const TURN_USER = 'luma';

/* 附加 TURN 节点（多线路择优）：TURN_EXTRA="host:port:secret,host:port:secret"
   浏览器会同时收集所有 relay 候选，谁先连通就用谁 —— 近的那条自然胜出。
   注意：这些节点必须公网可达，且 relay 端口要和映射一一对应，否则候选是死的。 */
const TURN_EXTRA = String(process.env.TURN_EXTRA || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [host, port, secret] = s.split(':');
    return { host: (host || '').trim(), port: (port || '3478').trim(), secret: (secret || '').trim() };
  })
  .filter((t) => t.host);

/* 默认 STUN：不配 TURN 时就是这一份，行为和以前完全一致 */
const DEFAULT_STUN = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:global.stun.twilio.com:3478'
];

/* ------------------------------------------------------------------ *
 * 内存状态（直播间是实时的，重启即清空，符合直播语义）
 * ------------------------------------------------------------------ */

const PALETTE = [
  '#a78bfa', '#f472b6', '#38bdf8', '#fbbf24', '#34d399',
  '#fb7185', '#c084fc', '#60a5fa', '#facc15', '#2dd4bf'
];

const SESSION_SECRET = crypto.randomBytes(32);
const SSE_QUEUE_MAX = 256 * 1024;
const clients = new Map(); // id -> { id, role, session, res, name, joinedAt }
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

/* 被顶替过的 host id。
   只切断旧连接是不够的：旧页面上的 EventSource 会自动重连，一回来又把
   新的顶掉，于是两个开播台每 2~3 秒互相踢一次，观众端的 offer 永远被打断，
   表现就是「直播中但一直黑屏」。
   这里记住「被谁顶下去的」，只要当前主播还活着就不许它再抢；
   当前主播下线后名单作废（可能确实是换回来）。 */
const supersededHosts = new Map(); // id -> ts
const SUPERSEDED_MAX = 200;

function noteSuperseded(id) {
  if (!id) return;
  supersededHosts.delete(id);
  supersededHosts.set(id, Date.now());
  if (supersededHosts.size > SUPERSEDED_MAX) {
    for (const k of supersededHosts.keys()) {
      supersededHosts.delete(k);
      if (supersededHosts.size <= SUPERSEDED_MAX / 2) break;
    }
  }
}

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

function sessionOf(req, res) {
  const cookie = String(req.headers.cookie || '').split(';').map((s) => s.trim())
    .find((s) => s.startsWith('luma_session='));
  const token = cookie ? cookie.slice('luma_session='.length) : '';
  const match = /^([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(token);
  const sign = (id) => crypto.createHmac('sha256', SESSION_SECRET).update(id).digest('hex');
  if (match && safeEqual(match[2], sign(match[1]))) return match[1];
  const id = crypto.randomBytes(32).toString('hex');
  res.setHeader('Set-Cookie', `luma_session=${id}.${sign(id)}; Path=/; HttpOnly; SameSite=Strict${req.socket.encrypted ? '; Secure' : ''}`);
  return id;
}

function keyOk(candidate) {
  if (!STREAM_KEY) return true;
  return safeEqual(candidate, STREAM_KEY);
}

/* ------------------------------------------------------------------ *
 * 口令尝试限速
 * ------------------------------------------------------------------ */

const authFails = new Map(); // ip -> { n, until, at }

function ipOf(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || '?';
}

/* 还剩多少毫秒解锁；0 表示没锁 */
function authLockLeft(req) {
  const rec = authFails.get(ipOf(req));
  if (!rec) return 0;
  const left = rec.until - Date.now();
  if (rec.until && left <= 0) authFails.delete(ipOf(req));
  return left > 0 ? left : 0;
}

function noteAuthFail(req) {
  const ip = ipOf(req);
  const now = Date.now();
  const rec = authFails.get(ip) || { n: 0, until: 0 };
  rec.n += 1;
  rec.at = now;
  if (rec.n >= AUTH_MAX_FAILS) rec.until = now + AUTH_LOCK_MS;
  authFails.set(ip, rec);

  /* 封顶，防止有人换着 IP 撑爆内存 */
  if (authFails.size > AUTH_MAP_MAX) {
    for (const k of authFails.keys()) {
      authFails.delete(k);
      if (authFails.size <= AUTH_MAP_MAX / 2) break;
    }
  }
}

function clearAuthFail(req) {
  authFails.delete(ipOf(req));
}

/* 统一的 429 响应：告诉调用方等多久 */
function tooMany(res, leftMs) {
  const sec = Math.max(1, Math.ceil(leftMs / 1000));
  return json(res, 429, { error: `尝试太频繁，请 ${sec} 秒后再试`, retryAfter: sec }, { 'Retry-After': String(sec) });
}

/* ------------------------------------------------------------------ *
 * ICE 配置（服务端下发，避免把 TURN 凭证硬编码到前端）
 * ------------------------------------------------------------------ */

/* 单个 TURN 节点的 iceServers 条目；凭证按 coturn REST 方式现签 */
function turnEntry(host, port, secret, tlsPort) {
  /* coturn 与 TURN 共用同一端口，顺手当 STUN 用：部分网络里 Google 的 STUN 不可达 */
  const urls = [
    `turn:${host}:${port}?transport=udp`,
    `turn:${host}:${port}?transport=tcp`
  ];
  if (tlsPort && tlsPort !== '0') urls.push(`turns:${host}:${tlsPort}?transport=tcp`);

  const entry = { urls };
  if (secret) {
    /* coturn REST 凭证：username = "<过期时间戳>:<用户名>"，
       credential = base64(HMAC-SHA1(secret, username))。两端 secret 必须一致。 */
    const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_SEC}:${TURN_USER}`;
    entry.username = username;
    entry.credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  }
  return entry;
}

function iceNodes() {
  const nodes = [];
  if (TURN_HOST) nodes.push({ host: TURN_HOST, port: TURN_PORT, secret: TURN_STATIC_AUTH_SECRET, tls: TURN_TLS_PORT });
  for (const t of TURN_EXTRA) nodes.push({ host: t.host, port: t.port, secret: t.secret, tls: '0' });
  return nodes;
}

function icePayload() {
  const servers = [{ urls: DEFAULT_STUN.slice() }];

  for (const node of iceNodes()) {
    servers.push({ urls: [`stun:${node.host}:${node.port}`] });
    servers.push(turnEntry(node.host, node.port, node.secret, node.tls));
  }

  return { iceServers: servers, ttl: TURN_TTL_SEC };
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
  if (!HOST_GRACE_MS) {
    stream.live = false;
    stream.startedAt = null;
    broadcast('stream-ended', { reason: 'host-disconnected' });
    broadcastState(true);
    return;
  }
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

function writeSse(res, frame) {
  if (res.destroyed || res.writableEnded) return false;
  if (res.writableLength + Buffer.byteLength(frame) > SSE_QUEUE_MAX) {
    res.destroy();
    return false;
  }
  try {
    res.write(frame);
    return true;
  } catch (err) {
    res.destroy();
    return false;
  }
}

function sendTo(id, event, data) {
  const c = clients.get(id);
  if (!c) return false;
  return writeSse(c.res, `event: ${event}\ndata: ${JSON.stringify(data === undefined ? {} : data)}\n\n`);
}

function broadcast(event, data, exceptId) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data === undefined ? {} : data)}\n\n`;
  for (const c of clients.values()) {
    if (c.id === exceptId) continue;
    writeSse(c.res, frame);
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

function json(res, code, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  }, headers || {}));
  res.end(body);
}

function readBody(req, limit = 96 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (err) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      chunks.length = 0;
      try {
        const body = raw ? JSON.parse(raw) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('expected object');
        settled = true;
        resolve(body);
      } catch (err) {
        fail(err);
      }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new Error('request aborted')));
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
      writeSse(c.res, ': ping\n\n');
    }
  }, 20000);
  heartbeat.unref();
}

function handleEvents(req, res, url) {
  const id = (url.searchParams.get('id') || '').slice(0, 64);
  const role = url.searchParams.get('role') === 'host' ? 'host' : 'viewer';
  const name = (url.searchParams.get('name') || '访客').slice(0, 24);

  if (!id) return json(res, 400, { error: 'missing id' });
  const previous = clients.get(id);
  if (previous && (previous.session !== req.session || previous.role !== role)) {
    return json(res, 409, { error: 'id already in use' });
  }

  /* host 身份必须凭口令取得，否则任何人都能抢走整个直播间。
     失败计入 IP 限速：爆破 5 次就锁 60 秒。 */
  if (role === 'host') {
    const left = authLockLeft(req);
    if (left > 0) return tooMany(res, left);
    if (!keyOk(url.searchParams.get('key') || '')) {
      noteAuthFail(req);
      return json(res, 401, { error: '开播口令不正确' });
    }
    clearAuthFail(req);

    /* 被顶替过的开播台：当前主播还活着就直接拒掉，别让它顶回来。
       页面主动点「在这里继续开播」会带 takeover=1，那是人的明确意图。 */
    const takeover = url.searchParams.get('takeover') === '1';
    const current = stream.hostId ? clients.get(stream.hostId) : null;
    if (!takeover && current && stream.hostId !== id && supersededHosts.has(id)) {
      return json(res, 403, {
        error: '已在别处开播',
        code: 'host-taken',
        hostId: stream.hostId
      });
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (res.flushHeaders) res.flushHeaders();
  writeSse(res, ': connected\n\n');

  // 同一会话、同一角色的 id 重连：踢掉旧连接
  if (previous) {
    try { previous.res.end(); } catch (err) { /* noop */ }
    clients.delete(id);
  }

  clients.set(id, { id, role, session: req.session, res, name, joinedAt: Date.now() });

  if (role === 'host') {
    /* 换了一台设备/换了标签页开播：让旧的那个安静退场。
       先发 host-taken 再断流，旧页面才知道「不是网络抖动，是被人接管了」，
       不会傻乎乎地自动重连回来把新的顶掉。 */
    if (stream.hostId && stream.hostId !== id) {
      const staleId = stream.hostId;
      const stale = clients.get(staleId);
      noteSuperseded(staleId);
      if (stale) {
        sendTo(staleId, 'host-taken', { by: id, at: Date.now() });
        try { stale.res.end(); } catch (err) { /* noop */ }
        clients.delete(staleId);
      }
    }
    supersededHosts.delete(id); // 它现在就是主播，不再是「被顶替者」
    stream.hostId = id;
    clearHostGrace(); // 宽限期内回来了 → 这场直播继续
  }

  /* 首包。ICE 配置每次下发都重新签名，客户端收到就覆盖（幂等）：
     EventSource 断线重连会让 welcome 再来一遍，不能只在第一次生效。
     TODO(安全)：EventSource 不支持自定义 POST，host 的口令只能留在 query 里，
     会进反向代理的访问日志。等改为「/api/auth 换短期 token → SSE 带 token」后去掉。 */
  sendTo(id, 'welcome', { id, role, ice: icePayload(), ...statePayload() });
  sendTo(id, 'history', chatLog.slice(-80));
  if (role === 'viewer') {
    if (stream.live && stream.hostId && stream.hostId !== id) {
      sendTo(stream.hostId, 'viewer-joined', { id, name });
    }
  }
  /* 主播重连（刷新页面、换设备、长连接被中间设备掐断后自愈）时，
     在场观众不会再次触发 viewer-joined，主播也就不知道要给他们发 offer，
     表现就是「直播中」但观众一直黑屏。这里补一次 go-live，主播端会
     按 viewers 列表重建全部连接。 */
  if (role === 'host' && stream.live) {
    sendTo(id, 'go-live', { viewers: viewerIds() });
  }

  broadcastState();

  startHeartbeat();

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;

    const current = clients.get(id);
    const isCurrent = Boolean(current && current.res === res);
    if (isCurrent) {
      clients.delete(id);
      lastChatAt.delete(`c:${id}`);
    }

    if (role === 'host') {
      /* 已经被同 id 的新连接顶替：这条旧连接的关闭与直播状态无关 */
      if (!isCurrent) return;
      if (stream.hostId === id) stream.hostId = null;
      /* 没有主播了：此时谁都可以来接管，「被顶替」名单作废 */
      if (!stream.hostId) supersededHosts.clear();
      if (stream.live) startHostGrace();
      else clearHostGrace();
      broadcastState();
      return;
    }

    if (isCurrent && stream.hostId) sendTo(stream.hostId, 'viewer-left', { id });
    broadcastState();
  };

  res.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
}

/* ------------------------------------------------------------------ *
 * 静态文件
 * ------------------------------------------------------------------ */

function serveStatic(req, res, url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch (err) {
    return json(res, 400, { error: 'bad URI' });
  }
  if (pathname.includes('\0')) return json(res, 400, { error: 'bad URI' });

  if (pathname === '/' || pathname === '/index.html') pathname = '/index.html';
  else if (pathname === '/studio' || pathname === '/studio/') pathname = '/studio.html';

  const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
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

  /* 开播端在重连之前先问一句：我这个 id 是不是已经被顶替了？
     EventSource 拿不到 403 的响应体，只能靠这个接口判断「是不是该安静退场」，
     不然被踢的页面会一直自动重连，和当前主播互相踢。 */
  if (req.method === 'GET' && route === '/api/host-status') {
    const id = String(url.searchParams.get('id') || '').slice(0, 64);
    const host = stream.hostId ? clients.get(stream.hostId) : null;
    return json(res, 200, {
      hostId: stream.hostId,
      hostOnline: Boolean(host),
      live: stream.live,
      mine: Boolean(id && stream.hostId === id),
      superseded: Boolean(id && supersededHosts.has(id)),
      /* 这个页面现在该不该安静退场 */
      taken: Boolean(id && host && stream.hostId !== id && supersededHosts.has(id))
    });
  }

  /* 校验口令（开播页在真正连 SSE 之前先问一句，便于给出明确提示）。
     只接受 POST：口令走 body，不会出现在反向代理的 URL 访问日志里。 */
  if (route === '/api/auth') {
    if (req.method !== 'POST') {
      return json(res, 405, { error: 'method not allowed，请用 POST' }, { Allow: 'POST' });
    }

    const left = authLockLeft(req);
    if (left > 0) return tooMany(res, left);

    let body;
    try { body = await readBody(req); } catch (err) { return json(res, 400, { error: 'bad body' }); }

    if (!STREAM_KEY) return json(res, 200, { ok: true, requireKey: false });

    if (!keyOk(body && body.key ? body.key : '')) {
      noteAuthFail(req);
      return json(res, 401, { ok: false, error: '开播口令不正确' });
    }
    clearAuthFail(req);
    return json(res, 200, { ok: true, requireKey: true });
  }

  if (req.method === 'POST' && route === '/api/signal') {
    let body;
    try { body = await readBody(req); } catch (err) { return json(res, 400, { error: 'bad body' }); }
    const { from, to, data } = body || {};
    if (!from || !to || !data) return json(res, 400, { error: 'from/to/data required' });

    /* from 必须属于当前浏览器会话；仅知道在线 id 不代表拥有连接。 */
    const fromId = String(from).slice(0, 64);
    const toId = String(to).slice(0, 64);
    const sender = clients.get(fromId);
    if (!sender || sender.session !== req.session) return json(res, 403, { error: 'sender not owned' });

    const target = clients.get(toId);
    if (!target) return json(res, 200, { delivered: false });

    /* 只允许 host ↔ viewer 两个方向：观众之间互发一律拒绝 */
    if (sender.role === target.role) {
      return json(res, 403, { error: 'signal direction not allowed' });
    }

    const delivered = sendTo(toId, 'signal', { from: sender.id, data });
    return json(res, 200, { delivered });
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
    if (conn && conn.session !== req.session) return json(res, 403, { error: 'sender not owned' });
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

    /* 这里也校验口令：/api/stream 会回 401 / 403 两种错，不设防就成了爆破探针 */
    if (STREAM_KEY) {
      const left = authLockLeft(req);
      if (left > 0) return tooMany(res, left);
      if (!keyOk(body.key || '')) {
        noteAuthFail(req);
        return json(res, 401, { error: '开播口令不正确' });
      }
      clearAuthFail(req);
    }

    const id = String(body.id || '');
    const host = clients.get(id);
    if (!id || id !== stream.hostId || !host || host.role !== 'host' || host.session !== req.session) {
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
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    decodeURIComponent(url.pathname);
  } catch (err) {
    return json(res, 400, { error: 'bad URI' });
  }
  req.session = sessionOf(req, res);

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

server.headersTimeout = 60000;
server.requestTimeout = 30000;
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
  if (TURN_HOST) {
    const chans = ['udp', 'tcp'];
    if (TURN_TLS_PORT && TURN_TLS_PORT !== '0') chans.push('tls');
    console.log(`  TURN 中继 ${TURN_HOST}:${TURN_PORT} · ${chans.join('/')} · 最近凭证 ${TURN_TTL_SEC / 3600}h`);
    if (!TURN_STATIC_AUTH_SECRET) {
      console.log('            未设 TURN_STATIC_AUTH_SECRET —— 用匿名中继，coturn 需开 no-auth');
    }
  } else if (!TURN_EXTRA.length) {
    console.log('  TURN 中继 未配置 —— 打洞失败的观众会黑屏（设 TURN_HOST 可补上）');
  }
  /* 附加节点单独列出，方便一眼看出多线路是否都吃到了 */
  for (const t of TURN_EXTRA) {
    const mark = t.secret ? 'REST 凭证' : '匿名中继';
    console.log(`  TURN 附加 ${t.host}:${t.port} · udp/tcp · ${mark}`);
  }
  if (AUTH_LOCK_MS) console.log(`  口令限速 ${AUTH_MAX_FAILS} 次失败锁 ${AUTH_LOCK_MS / 1000}s${TRUST_PROXY ? '（读 X-Forwarded-For）' : ''}`);
});
