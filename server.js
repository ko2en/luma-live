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

/* ---------------- 授信用户登录（白名单账号 + 签名 cookie） ----------------
   AUTH_USERS 格式：`用户名:密码[,用户名:密码 ...]`
   密码可以写明文，也可以写 sha256 摘要（`sha256:<64位hex>`，
   用 `node scripts/hash-pass.js 明文` 生成）。摘要方式避免配置里出现明文。
   一旦配了账号，全站（观看页 / 开播台 / 所有 API / SSE）都必须先登录。
   不配则维持旧的公开模式 + 可选开播口令，方便本机和已有部署平滑升级。 */
function parseAuthUsers(raw) {
  const map = new Map();
  for (const item of String(raw || '').split(',')) {
    const s = item.trim();
    if (!s) continue;
    const i = s.indexOf(':');
    if (i <= 0) continue;
    const name = s.slice(0, i).trim();
    const cred = s.slice(i + 1).trim();
    if (name && cred && !map.has(name)) map.set(name, cred);
  }
  return map;
}
const AUTH_SEED = parseAuthUsers(process.env.AUTH_USERS);

/* ---------------- 可自助维护的账号库（用户名 / 密码摘要 / 头像） ----------------
   env 的 AUTH_USERS 只是首次种子：第一次启动时写入 DATA_DIR/users.json，
   之后以文件为唯一真相 —— 用户可在网页里改自己的账号、密码、头像。
   元数据文件放 DATA_DIR，头像放 DATA_DIR/avatars；均限制为本地路径。 */
const DATA_DIR = path.resolve(process.env.LUMA_DATA_DIR || path.join(__dirname, 'data'));
const USER_FILE = path.join(DATA_DIR, 'users.json');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const USER_FILE_MAX = 2 * 1024 * 1024;
const AVATAR_MAX_BYTES = 512 * 1024;
const ALLOWED_AVATAR_EXT = new Set(['.png', '.jpg', '.webp']);

/* name -> { cred, avatar }，cred 为明文或 sha256:摘要；avatar 为纯文件名 `<hash>.<ext>` */
const USER_DB = new Map();

function saveUserFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${USER_FILE}.${process.pid}.tmp`;
  const payload = JSON.stringify({ version: 1, users: Object.fromEntries(USER_DB) }, null, 2);
  fs.writeFileSync(tmp, payload, { mode: 0o600 });
  fs.renameSync(tmp, USER_FILE);
}

function loadUserFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  let loaded = false;
  try {
    const st = fs.statSync(USER_FILE);
    if (st.size <= USER_FILE_MAX) {
      const raw = JSON.parse(fs.readFileSync(USER_FILE, 'utf8'));
      if (raw && raw.users && typeof raw.users === 'object' && !Array.isArray(raw.users)) {
        for (const [name, rec] of Object.entries(raw.users)) {
          if (!name || !rec || !rec.cred) continue;
          const avatar = String(rec.avatar || '').replace(/^\/api\/avatar\//, '');
          USER_DB.set(String(name).slice(0, 64), {
            cred: String(rec.cred),
            avatar: validAvatarFile(avatar) ? avatar : ''
          });
        }
        loaded = true;
      }
    }
  } catch (err) { /* 文件不存在或损坏：回退到 env 种子 */ }

  if (!loaded && USER_DB.size === 0) {
    for (const [name, cred] of AUTH_SEED) USER_DB.set(name, { cred, avatar: '' });
    if (USER_DB.size) {
      try { saveUserFile(); } catch (err) { console.error('账号库初始化失败：', err.message); }
    }
  }
}
loadUserFile();

/* 账号合法字符：中文 / 字母数字 / 下划线 / 连字符，2–24 字 */
function validUserName(name) {
  return /^[\w\u4e00-\u9fa5-]{2,24}$/.test(String(name || ''));
}
/* 头像文件名只允许 32位hex.扩展名，杜绝路径穿越 */
function validAvatarFile(file) {
  return /^[a-f0-9]{32}\.(png|jpg|webp)$/.test(String(file || ''));
}
/* 按文件头识别真实图片类型，不信任前端声明的 MIME */
function sniffImage(buf) {
  if (!buf || buf.length < 16) return '';
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG'
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  /* WebP: RIFF....WEBP */
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return '';
}
function avatarUrlOf(user) {
  const rec = USER_DB.get(user);
  return rec && validAvatarFile(String(rec.avatar || '').replace(/^\/api\/avatar\//, ''))
    ? `/api/avatar/${rec.avatar}` : '';
}

const AUTH_ENABLED = USER_DB.size > 0;
const AUTH_COOKIE = 'luma_auth';
const AUTH_TTL_SEC = Math.max(3600, Number(process.env.AUTH_TTL_SEC || 30 * 86400));
/* 配了固定密钥，服务重启后登录态仍然有效；不配则每次重启都要重新登录。 */
const AUTH_SECRET_RAW = String(process.env.AUTH_SECRET || '').trim();

/* 主播 SSE 掉线后的宽限期：媒体连接独立于信令，SSE 断了画面还在，
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

/* ---------------- TURN 线路（全部可选，不配就完全走 STUN 直连） ----------------
   一条线路 = 一个 TURN 入口。TURN_LINES 用 `id|host|port|secret|标题` 描述，
   多条用逗号分隔；secret 留空表示匿名中继。p2p 是内置线路：
   只下发 STUN、不给任何 TURN，通不通全看两边能不能打洞。
   凭证按 coturn 的 REST 方式（static-auth-secret）用 HMAC-SHA1 现签，6 小时有效。 */
const TURN_TTL_SEC = 6 * 60 * 60;
const TURN_USER = 'luma';

function parseTurnLines(raw) {
  return String(raw || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [id, host, port, secret, title] = x.split('|').map((v) => String(v || '').trim());
      return { id: id || host, host, port: port || '3478', secret, title: title || id || host };
    })
    .filter((l) => l.host);
}

const TURN_LINES = parseTurnLines(process.env.TURN_LINES);

/* 兼容老部署：只配了 TURN_HOST / TURN_EXTRA 时，把它们转成线路 */
const TURN_HOST = String(process.env.TURN_HOST || '').trim();
const TURN_PORT = String(process.env.TURN_PORT || '3478').trim();
const TURN_STATIC_AUTH_SECRET = String(process.env.TURN_STATIC_AUTH_SECRET || '').trim();
const TURN_LABEL = String(process.env.TURN_LABEL || '').trim();
if (!TURN_LINES.length && TURN_HOST) {
  TURN_LINES.push({
    id: 'main', host: TURN_HOST, port: TURN_PORT,
    secret: TURN_STATIC_AUTH_SECRET, title: TURN_LABEL || '主线路'
  });
  for (const raw of String(process.env.TURN_EXTRA || '').split(',')) {
    const [host, port, secret, label] = raw.split(':');
    if (!host || !host.trim()) continue;
    const id = (label || host).trim();
    TURN_LINES.push({
      id, host: host.trim(), port: (port || '3478').trim(),
      secret: (secret || '').trim(), title: id
    });
  }
}

/* 默认线路：TURN_DEFAULT 填线路 id；不设就用第一条 TURN 线路（没有就是 p2p） */
const TURN_DEFAULT = String(process.env.TURN_DEFAULT || '').trim();
/* 中继线路固定为配置里的第一条（当前只有西安一台）。
   名字交给 TURN_LINES 的标题决定，代码里不再写死城市名——换机房只改环境变量。 */
const RELAY_LINE = TURN_LINES[0] || null;
const RELAY_TITLE = (RELAY_LINE && RELAY_LINE.title) || '中继';

/* 不再保留默认兜底：只有一条 relay 线路，失败就停在未连接，不换路。 */
const DEFAULT_STUN = [];

/* ------------------------------------------------------------------ *
 * 内存状态（直播间是实时的，重启即清空，符合直播语义）
 * ------------------------------------------------------------------ */

/* 昵称配色跟随主站：墨黑 / 朱红 / 灰阶 */
const PALETTE = [
  '#111111', '#e8462f', '#4a4a4a', '#8a8a86', '#c6371f',
  '#2c2c2c', '#6b6b66', '#a5a5a0', '#7a3b30', '#3f3f3c'
];

const SESSION_SECRET = AUTH_SECRET_RAW
  ? crypto.createHash('sha256').update(`luma-session\0${AUTH_SECRET_RAW}`).digest()
  : crypto.randomBytes(32);
const SSE_QUEUE_MAX = 256 * 1024;
const clients = new Map(); // id -> { id, role, session, res, name, joinedAt }
/* 账号 -> 当前活跃连接 id。登录模式下同一账号同时只能有一处（看或播），
   新连接上线会把旧连接踢下线，防止账号泄露后被多处滥用。
   未启用登录时不写入（name 来自 query，不可信，也就无从谈账号唯一）。 */
const accountConns = new Map();
const chatLog = [];        // 最近 120 条
let chatSeq = 0;
/* 限速键是「连接」，不是昵称：换昵称绕不过去，连接断开后由宽限期清扫 */
const lastChatAt = new Map();

const stream = {
  live: false,
  title: '在代码与夜色之间 · 独立开发的第 100 天',
  streamer: 'Luma',
  bio: '',
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

/* 一个请求可能同时种 session 和 auth 两个 cookie，append 而不是覆盖。 */
function addCookie(res, line) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', line);
  else if (Array.isArray(prev)) res.setHeader('Set-Cookie', prev.concat(line));
  else res.setHeader('Set-Cookie', [prev, line]);
}

/* 对外恒为 HTTPS 的部署（如 CDN 回源走 HTTP 的 Flexible SSL）可强制加 Secure，
   不依赖回源协商出来的 X-Forwarded-Proto。 */
const FORCE_SECURE_COOKIE = process.env.COOKIE_SECURE === '1' || process.env.COOKIE_SECURE === 'true';

function secureCookie(req) {
  if (FORCE_SECURE_COOKIE) return true;
  if (req.socket.encrypted) return true;
  if (TRUST_PROXY) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (proto === 'https') return true;
  }
  return false;
}

function sessionOf(req, res) {
  const cookie = String(req.headers.cookie || '').split(';').map((s) => s.trim())
    .find((s) => s.startsWith('luma_session='));
  const token = cookie ? cookie.slice('luma_session='.length) : '';
  const match = /^([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(token);
  const sign = (id) => crypto.createHmac('sha256', SESSION_SECRET).update(id).digest('hex');
  if (match && safeEqual(match[2], sign(match[1]))) return match[1];
  const id = crypto.randomBytes(32).toString('hex');
  addCookie(res, `luma_session=${id}.${sign(id)}; Path=/; HttpOnly; SameSite=Strict${secureCookie(req) ? '; Secure' : ''}`);
  return id;
}

function keyOk(candidate) {
  if (!STREAM_KEY) return true;
  return safeEqual(candidate, STREAM_KEY);
}

/* ---------------- 登录账号校验与凭证 ---------------- */

function credentialOk(stored, input) {
  const m = /^sha256:([a-f0-9]{64})$/i.exec(String(stored || ''));
  const got = m
    ? crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex')
    : String(input || '');
  return safeEqual(got, m ? m[1].toLowerCase() : String(stored || ''));
}

/* cookie: base64url(用户名).过期秒.签名。签名覆盖用户名+过期+凭证摘要，
   所以管理员改了某人的密码，旧 cookie 立即失效，不用等它过期。 */
function authSign(user, exp, fp) {
  return crypto.createHmac('sha256', SESSION_SECRET)
    .update(`luma-auth\0${user}\0${exp}\0${fp}`).digest('hex');
}
function credFingerprint(cred) {
  return crypto.createHash('sha256').update(String(cred), 'utf8').digest('hex').slice(0, 32);
}

function authUserOf(req) {
  if (!AUTH_ENABLED) return null;
  const cookie = String(req.headers.cookie || '').split(';').map((s) => s.trim())
    .find((s) => s.startsWith(`${AUTH_COOKIE}=`));
  if (!cookie) return null;
  const token = cookie.slice(AUTH_COOKIE.length + 1);
  const m = /^([A-Za-z0-9_-]+)\.(\d{10})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(token);
  if (!m) return null;
  let user;
  try { user = Buffer.from(m[1], 'base64url').toString('utf8'); } catch (err) { return null; }
  const cred = USER_DB.get(user) && USER_DB.get(user).cred;
  if (!cred) return null;
  const exp = Number(m[2]);
  if (!exp || exp * 1000 <= Date.now()) return null;
  const fp = credFingerprint(cred);
  if (!safeEqual(m[3], fp) || !safeEqual(m[4], authSign(user, exp, fp))) return null;
  return user;
}

function grantAuth(req, res, user) {
  const cred = USER_DB.get(user) && USER_DB.get(user).cred;
  const exp = Math.floor(Date.now() / 1000) + AUTH_TTL_SEC;
  const raw = Buffer.from(user, 'utf8').toString('base64url');
  const fp = credFingerprint(cred);
  const token = `${raw}.${exp}.${fp}.${authSign(user, exp, fp)}`;
  addCookie(res, `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${AUTH_TTL_SEC}${secureCookie(req) ? '; Secure' : ''}`);
}

function revokeAuth(res) {
  addCookie(res, `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
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

/* 单条线路的 iceServers 条目；凭证按 coturn REST 方式现签 */
function turnEntry(host, port, secret) {
  /* coturn 与 TURN 共用同一端口，顺手当 STUN 用：部分网络里 Google 的 STUN 不可达 */
  const urls = [
    `turn:${host}:${port}?transport=udp`,
    `turn:${host}:${port}?transport=tcp`
  ];
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

/* 页面固定使用唯一的中继线路；此清单仅供状态提示标注节点名，不提供线路切换。 */
function lineOptions() {
  return RELAY_LINE ? [{ id: RELAY_LINE.id, title: RELAY_TITLE, host: RELAY_LINE.host }] : [];
}

function findLine(id) {
  const want = String(id || '').trim().toLowerCase();
  if (!want) return null;
  return TURN_LINES.find((l) => l.id.toLowerCase() === want) || null;
}

function defaultLine() {
  if (TURN_DEFAULT) {
    const hit = findLine(TURN_DEFAULT);
    if (hit) return hit;
  }
  return TURN_LINES[0] || null;
}

/* 忽略客户端旧版本携带的线路参数：始终固定唯一中继线路，绝不回退到其它节点。 */
function pickLine() {
  return RELAY_LINE;
}

function icePayload() {
  const line = pickLine();
  const servers = line
    ? [turnEntry(line.host, line.port, line.secret)]
    : [];
  return {
    iceServers: servers,
    ttl: TURN_TTL_SEC,
    iceTransportPolicy: 'relay',
    line: line ? line.id : '',
    lines: lineOptions()
  };
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

/* 主播要给每个观众单独建 peer，所以除了 id 还要带它当前选的线路。 */
function viewerDescriptors() {
  const out = [];
  for (const c of clients.values()) {
    if (c.role === 'viewer') out.push({ id: c.id, line: c.line || 'p2p' });
  }
  return out;
}

/* 在场名单：当前所有连接（主播+观众）的显示名，按加入时间排序、去重。
   前端据此列出「谁在看」，同账号单连接后一个名字最多出现一次。 */
function audienceList() {
  const seen = new Set();
  const out = [];
  const sorted = [...clients.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  for (const c of sorted) {
    if (!c.name || seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({ name: c.name, role: c.role, avatar: avatarUrlOf(c.name) });
  }
  return out;
}

function statePayload() {
  return {
    live: stream.live,
    title: stream.title,
    streamer: stream.streamer,
    streamerAvatar: avatarUrlOf(stream.streamer),
    bio: stream.bio,
    muted: stream.muted,
    startedAt: stream.startedAt,
    viewers: viewerCount(),
    audience: audienceList(),
    hostOnline: Boolean(stream.hostId),
    /* 当前中继线路：前端「线路」栏数据驱动显示，不写死城市名。
       未来增加中转服务器只需往 TURN_LINES 追加，这里自动跟着变。 */
    line: RELAY_LINE
      ? { id: RELAY_LINE.id, title: RELAY_TITLE, host: RELAY_LINE.host }
      : null,
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

/* 账号级单连接：一个授信账号同时只允许一个活动连接（看或播都算）。
   新连接上线时把同账号的旧连接踢掉，旧页面收到 account-taken 会停播/停看
   且不再自动重连，避免账号泄露后被多处滥用。未启用登录时不生效。 */
function evictAccount(user, keepId) {
  if (!user) return;
  const oldId = accountConns.get(user);
  if (!oldId || oldId === keepId) return;
  accountConns.delete(user);
  const stale = clients.get(oldId);
  if (!stale) return;

  sendTo(oldId, 'account-taken', { by: keepId, at: Date.now() });
  try { stale.res.end(); } catch (err) { /* noop */ }
  clients.delete(oldId);
  lastChatAt.delete(`c:${oldId}`);

  if (stale.role === 'host') {
    if (stream.hostId === oldId) {
      stream.hostId = null;
      supersededHosts.clear();
      clearHostGrace();
      if (stream.live) {
        stream.live = false;
        stream.startedAt = null;
        broadcast('stream-ended', { reason: 'account-taken' });
      }
    }
  } else if (stream.hostId) {
    sendTo(stream.hostId, 'viewer-left', { id: oldId });
  }
  broadcastState(true);
}

function handleEvents(req, res, url) {
  const id = (url.searchParams.get('id') || '').slice(0, 64);
  const role = url.searchParams.get('role') === 'host' ? 'host' : 'viewer';
  /* 名字一律以登录账号为准：前端 query 里的 name 不可信，人人都能改。
     没启用登录时退回 query 的 name，保持旧部署行为不变。 */
  const sessionUser = AUTH_ENABLED ? authUserOf(req) : null;
  const name = (sessionUser || url.searchParams.get('name') || '访客').slice(0, 24);
  /* 忽略旧版页面携带的 turn 参数，直播固定走唯一中继 TURN。 */
  const line = pickLine();
  const lineId = role === 'viewer' && line ? line.id : '';

  if (!id) return json(res, 400, { error: 'missing id' });
  const previous = clients.get(id);
  const oldLine = previous && previous.role === 'viewer' ? (previous.line || 'p2p') : '';
  if (previous && (previous.session !== req.session || previous.role !== role)) {
    return json(res, 409, { error: 'id already in use' });
  }

  /* host 身份必须凭凭证取得，否则任何人都能抢走整个直播间。
     登录模式下凭登录 cookie（已在全局闸门校验）；否则退回开播口令。
     失败计入 IP 限速：爆破 5 次就锁 60 秒。 */
  if (role === 'host') {
    const left = authLockLeft(req);
    if (left > 0) return tooMany(res, left);
    if (!AUTH_ENABLED && !keyOk(url.searchParams.get('key') || '')) {
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

  /* 账号级单连接：同一授信账号在别处上线 → 踢掉它之前的连接。
     id 相同（同页面重连）不算「别处」，只走下面的 previous 逻辑。 */
  if (sessionUser) {
    const accountId = accountConns.get(sessionUser);
    if (accountId && accountId !== id) evictAccount(sessionUser, id);
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

  clients.set(id, { id, role, session: req.session, res, name, joinedAt: Date.now(), line: lineId });
  if (sessionUser) accountConns.set(sessionUser, id);

  /* 观众切换线路会带新 turn= 重连：告诉主播重建这一路 peer，
     否则主播还用旧线路的 ICE 配置，两端候选集对不上就黑屏。 */
  if (oldLine && oldLine !== lineId && stream.hostId) {
    sendTo(stream.hostId, 'viewer-line', { id, line: lineId });
  }

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
    /* 主播名 = 登录账号（未启用登录时是 query name）。观众页据此显示
       「正在直播的用户」，不写死任何名字。 */
    stream.streamer = name;
    clearHostGrace(); // 宽限期内回来了 → 这场直播继续
  }

  /* 首包。ICE 配置每次下发都重新签名，客户端收到就覆盖（幂等）：
     EventSource 断线重连会让 welcome 再来一遍，不能只在第一次生效。
     TODO(安全)：EventSource 不支持自定义 POST，host 的口令只能留在 query 里，
     会进反向代理的访问日志。等改为「/api/auth 换短期 token → SSE 带 token」后去掉。 */
  const ice = icePayload();
  sendTo(id, 'welcome', { id, role, ice, ...statePayload() });
  sendTo(id, 'history', chatLog.slice(-80));
  if (role === 'viewer') {
    if (stream.live && stream.hostId && stream.hostId !== id) {
      sendTo(stream.hostId, 'viewer-joined', { id, name, line: lineId });
    }
  }
  /* 主播重连（刷新页面、换设备、长连接被中间设备掐断后自愈）时，
     在场观众不会再次触发 viewer-joined，主播也就不知道要给他们发 offer，
     表现就是「直播中」但观众一直黑屏。这里补一次 go-live，主播端会
     按 viewers 列表重建全部连接。 */
  if (role === 'host' && stream.live) {
    sendTo(id, 'go-live', { viewers: viewerDescriptors() });
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
      /* 账号映射只在该连接仍是账号当前连接时才清，别把「别处新登录」的映射删掉 */
      if (sessionUser && accountConns.get(sessionUser) === id) accountConns.delete(sessionUser);
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
  else if (pathname === '/login' || pathname === '/login/') pathname = '/login.html';

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

  /* 登录接口本身必须免鉴权可访问，否则永远登不进来。 */
  if (route === '/api/login') {
    if (req.method !== 'POST') {
      return json(res, 405, { error: 'method not allowed，请用 POST' }, { Allow: 'POST' });
    }
    if (!AUTH_ENABLED) return json(res, 200, { ok: true, requireLogin: false });
    const left = authLockLeft(req);
    if (left > 0) return tooMany(res, left);

    let body;
    try { body = await readBody(req); } catch (err) { return json(res, 400, { error: 'bad body' }); }
    const user = String((body && body.user) || '').trim().slice(0, 64);
    const pass = String((body && body.pass) || '');
    const cred = USER_DB.get(user) && USER_DB.get(user).cred;

    /* 用户名不存在也走一次摘要比较，避免用响应耗时枚举账号。 */
    const dummy = 'sha256:' + '0'.repeat(64);
    const ok = credentialOk(cred || dummy, pass) && Boolean(cred);
    if (!ok) {
      noteAuthFail(req);
      return json(res, 401, { ok: false, error: '账号或密码不正确' });
    }
    clearAuthFail(req);
    grantAuth(req, res, user);
    return json(res, 200, { ok: true, requireLogin: true, user });
  }

  if (route === '/api/logout') {
    revokeAuth(res);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && route === '/api/me') {
    const user = authUserOf(req);
    return json(res, 200, {
      authenticated: !AUTH_ENABLED || Boolean(user),
      requireLogin: AUTH_ENABLED,
      user: user || null,
      avatar: user ? avatarUrlOf(user) : ''
    });
  }

  /* 头像图片读取：文件名白名单，只允许 DATA_DIR/avatars 下的 png/jpg/webp。
     图片本身不敏感，但仍走全局鉴权闸门（未登录访问不到），避免被当图床。 */
  if (req.method === 'GET' && route.startsWith('/api/avatar/')) {
    const file = route.slice('/api/avatar/'.length);
    if (!validAvatarFile(file)) return json(res, 404, { error: 'not found' });
    const filePath = path.join(AVATAR_DIR, file);
    /* 再校验一次真实路径，杜绝任何形式的目录逃逸 */
    if (path.relative(AVATAR_DIR, path.resolve(filePath)).startsWith('..')) {
      return json(res, 404, { error: 'not found' });
    }
    return fs.readFile(filePath, (err, data) => {
      if (err) return json(res, 404, { error: 'not found' });
      const ext = path.extname(file);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(data);
    });
  }

  /* 账号自助维护：改账号名 / 改密码。必须提供当前密码，防别人趁你离开改掉。 */
  if (req.method === 'POST' && route === '/api/account') {
    if (!AUTH_ENABLED) return json(res, 400, { error: '未启用登录，无需修改' });
    const user = authUserOf(req);
    if (!user) return json(res, 401, { error: '请先登录' });
    const left = authLockLeft(req);
    if (left > 0) return tooMany(res, left);

    let body;
    try { body = await readBody(req); } catch (err) { return json(res, 400, { error: 'bad body' }); }
    const currentPass = String((body && body.currentPass) || '');
    const rec = USER_DB.get(user);
    if (!credentialOk(rec.cred, currentPass)) {
      noteAuthFail(req);
      return json(res, 401, { error: '当前密码不正确' });
    }
    clearAuthFail(req);

    const newUser = String((body && body.newUser) || '').trim().slice(0, 24);
    const newPass = String((body && body.newPass) || '');
    const wantRename = Boolean(newUser) && newUser !== user;
    const wantPass = Boolean(newPass);
    if (!wantRename && !wantPass) return json(res, 400, { error: '没有需要修改的内容' });
    if (wantRename) {
      if (!validUserName(newUser)) {
        return json(res, 400, { error: '账号需 2–24 位：中文、字母、数字、下划线或连字符' });
      }
      if (USER_DB.has(newUser)) return json(res, 409, { error: '该账号已存在' });
    }
    if (wantPass && newPass.length < 6) return json(res, 400, { error: '新密码至少 6 位' });

    if (wantPass) rec.cred = `sha256:${crypto.createHash('sha256').update(newPass, 'utf8').digest('hex')}`;
    if (wantRename) {
      USER_DB.delete(user);
      USER_DB.set(newUser, rec);
      /* 同步改写运行态里对这个账号的引用：在线连接、账号单连接映射、主播名。 */
      for (const c of clients.values()) if (c.name === user) c.name = newUser;
      if (accountConns.has(user)) {
        accountConns.set(newUser, accountConns.get(user));
        accountConns.delete(user);
      }
      if (stream.streamer === user) stream.streamer = newUser;
    }
    try { saveUserFile(); } catch (err) { return json(res, 500, { error: '保存失败' }); }

    /* 改账号名或密码后，旧 cookie 的签名指纹失效；当场换发新 cookie，避免用户被踢。 */
    const finalUser = wantRename ? newUser : user;
    revokeAuth(res);
    grantAuth(req, res, finalUser);
    broadcastState(true);
    return json(res, 200, {
      ok: true,
      user: finalUser,
      changed: { name: wantRename, password: wantPass },
      avatar: avatarUrlOf(finalUser)
    });
  }

  /* 头像上传：接受 data URL（png/jpeg/webp），校验魔数后按内容哈希落盘。
     不信任前端声明的类型，只认文件头；体积上限 512KB，防止当图床塞满磁盘。 */
  if (req.method === 'POST' && route === '/api/avatar') {
    if (!AUTH_ENABLED) return json(res, 400, { error: '未启用登录，无需上传' });
    const user = authUserOf(req);
    if (!user) return json(res, 401, { error: '请先登录' });
    let body;
    try { body = await readBody(req, AVATAR_MAX_BYTES * 2 + 4096); } catch (err) {
      return json(res, 400, { error: '图片过大' });
    }
    const raw = String((body && body.image) || '');
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
    if (!m) return json(res, 400, { error: '只支持 PNG / JPEG / WebP 图片' });
    let buf;
    try { buf = Buffer.from(m[2], 'base64'); } catch (err) { return json(res, 400, { error: '图片数据无效' }); }
    if (!buf.length || buf.length > AVATAR_MAX_BYTES) return json(res, 400, { error: '图片不能超过 512KB' });

    const ext = sniffImage(buf);
    if (!ext) return json(res, 400, { error: '图片内容与格式不符' });
    const file = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)}${ext}`;
    const outPath = path.join(AVATAR_DIR, file);
    try {
      fs.mkdirSync(AVATAR_DIR, { recursive: true });
      if (!fs.existsSync(outPath)) fs.writeFileSync(outPath, buf, { mode: 0o644 });
    } catch (err) { return json(res, 500, { error: '保存失败' }); }

    const rec = USER_DB.get(user);
    const oldFile = rec.avatar;
    rec.avatar = file;
    try { saveUserFile(); } catch (err) { return json(res, 500, { error: '保存失败' }); }
    /* 旧头像若无人再用就删掉，避免堆积；被多人共用时保留。 */
    if (oldFile && oldFile !== file) {
      const stillUsed = [...USER_DB.values()].some((r) => r.avatar === oldFile);
      if (!stillUsed) { try { fs.unlinkSync(path.join(AVATAR_DIR, oldFile)); } catch (err) { /* noop */ } }
    }
    broadcastState(true);
    return json(res, 200, { ok: true, avatar: `/api/avatar/${file}` });
  }

  if (req.method === 'GET' && route === '/api/state') {
    return json(res, 200, statePayload());
  }

  /* 开播端启动时问一次：这台服务器要不要口令 / 要不要登录？
     只回答「要不要」，不泄露任何凭证，也不需要鉴权。 */
  if (req.method === 'GET' && route === '/api/config') {
    return json(res, 200, {
      requireLogin: AUTH_ENABLED,
      requireKey: !AUTH_ENABLED && Boolean(STREAM_KEY),
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

    /* 登录模式下开播资格由登录态决定，先看登录 cookie 是否有效。 */
    if (AUTH_ENABLED) {
      if (!authUserOf(req)) return json(res, 401, { ok: false, error: '请先登录' });
      return json(res, 200, { ok: true, requireKey: false, requireLogin: true });
    }
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

    /* 身份以 SSE 连接为准：连着的就用连接上的角色和名字（登录账号），
       body 里的 name 不再采信，换昵称既绕不过限速也改不了显示名。
       没连着的（直连 API）只按 IP 限速，且永远拿不到「主播」标签。 */
    const clientId = String(body.clientId || body.id || '').slice(0, 64);
    const conn = clientId ? clients.get(clientId) : null;
    if (conn && conn.session !== req.session) return json(res, 403, { error: 'sender not owned' });
    /* 登录模式下名字一律取当前登录账号：即便旧页面还活着、或有人伪造 clientId，
       显示名也冒充不了别人；被顶替的连接已不在 accountConns 中，直接拒发。 */
    const sessionUser = AUTH_ENABLED ? authUserOf(req) : null;
    if (sessionUser && accountConns.get(sessionUser) !== clientId) {
      return json(res, 403, { error: '账号已在别处使用', code: 'account-taken' });
    }
    const role = conn && conn.role === 'host' ? 'host' : 'viewer';
    const shownName = sessionUser || (conn ? (conn.name || name) : name);

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
      avatar: avatarUrlOf(shownName),
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

    /* 这里也校验口令：/api/stream 会回 401 / 403 两种错，不设防就成了爆破探针。
       登录模式下全局闸门已校验登录态，这里不再检查开播口令。 */
    if (!AUTH_ENABLED && STREAM_KEY) {
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
      sendTo(stream.hostId, 'go-live', { viewers: viewerDescriptors() });
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

  /* 无需登录即可访问：登录页本身、它的脚本、公共样式，以及登录相关 API。
     /api/login、/api/logout、/api/me 由 handleApi 内部处理（其中 login 免鉴权）。 */
  const PUBLIC_PATHS = new Set(['/login', '/login.html', '/login.js', '/styles.css']);
  const authFree = !AUTH_ENABLED
    || PUBLIC_PATHS.has(url.pathname)
    || url.pathname === '/api/login'
    || url.pathname === '/api/logout'
    || url.pathname === '/api/me'
    || url.pathname === '/api/config'
    || url.pathname === '/api/auth';
  if (!authFree && !authUserOf(req)) {
    if (url.pathname.startsWith('/api/')) {
      return json(res, 401, { error: '请先登录', code: 'login-required' });
    }
    const next = encodeURIComponent(url.pathname + (url.search || ''));
    res.writeHead(302, { Location: `/login?next=${next}`, 'Cache-Control': 'no-store' });
    return res.end();
  }

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
  if (AUTH_ENABLED) {
    console.log(`  登录      已启用（AUTH_USERS），共 ${USER_DB.size} 个授信账号；观看与开播均需登录`);
    console.log(`  登录页    http://localhost:${PORT}/login`);
    if (!AUTH_SECRET_RAW) console.log('  提示      未设 AUTH_SECRET，服务重启后所有人需重新登录');
  } else {
    console.log('  登录      未启用 —— 观看页完全公开（设 AUTH_USERS 可开启授信登录）');
    if (STREAM_KEY) {
      console.log('  开播口令  已启用（STREAM_KEY），开播端需要输入口令');
    } else {
      console.log('  开播口令  未启用 —— 任何能打开 /studio 的人都可以开播。');
      console.log('            公网部署请设置 AUTH_USERS 或环境变量 STREAM_KEY=你的口令');
    }
  }
  if (HOST_GRACE_MS) console.log(`  断线宽限  ${HOST_GRACE_MS} ms（主播掉线后不立即结束直播）`);
  if (TURN_LINES.length) {
    for (const l of TURN_LINES) {
      const mark = l.secret ? 'REST 凭证' : '匿名中继';
      console.log(`  TURN 线路  ${l.id}（${l.title}）→ ${l.host}:${l.port} · ${mark}`);
    }
    console.log(`  固定线路  ${RELAY_LINE ? `${RELAY_LINE.id}（${RELAY_TITLE}）` : '未配置中继 TURN'}`);
  } else {
    console.log('  TURN 中继 未配置 —— 打洞失败的观众会黑屏（设 TURN_LINES 可补上）');
  }
  if (AUTH_LOCK_MS) console.log(`  口令限速 ${AUTH_MAX_FAILS} 次失败锁 ${AUTH_LOCK_MS / 1000}s${TRUST_PROXY ? '（读 X-Forwarded-For）' : ''}`);
});
