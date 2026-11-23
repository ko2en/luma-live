'use strict';

/**
 * 所有环境变量的唯一入口。
 *
 * 规则：
 *  - 只在这里读 process.env，别处一律从 config 取值；
 *  - 默认值、取值范围、兼容老变量的转换都集中在这一层；
 *  - 解析失败不抛异常（服务要能起来并给出 /readyz 诊断），只做兜底。
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const bool = (v) => v === '1' || v === 'true';
const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
const str = (v, def = '') => String(v === undefined || v === null ? def : v).trim();

/* ------------------------------------------------------------------ 基础 */

const PORT = num(process.env.PORT, 3000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/* 开播口令：设了就必须带对才能占住 host 身份。
   不设则任何人打开 /studio 都能开播（只适合本机/内网自用）。 */
const STREAM_KEY = str(process.env.STREAM_KEY);

/* ------------------------------------------------------------------ 数据目录 */

const DATA_DIR = path.resolve(process.env.LUMA_DATA_DIR || path.join(__dirname, '..', 'data'));
const USER_FILE = path.join(DATA_DIR, 'users.json');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const USER_FILE_MAX = 2 * 1024 * 1024;
const AVATAR_MAX_BYTES = 512 * 1024;
const ALLOWED_AVATAR_EXT = new Set(['.png', '.jpg', '.webp']);

/* 启动就把数据目录建好：/readyz 拿 W_OK 判断是否可写，第一次部署时目录还不存在 */
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (err) { /* 只读文件系统：留给 /readyz 报 */ }

/* ------------------------------------------------------------------ 账号 */

/* ---------------- 授信用户登录（白名单账号 + 签名 cookie） ----------------
   AUTH_USERS 格式：`用户名:密码[,用户名:密码 ...]`
   密码可以写明文，也可以写摘要（`node scripts/hash-pass.js 明文` 生成）：
     scrypt:<N>:<r>:<p>:<salt>:<hash>   ← 当前算法，首次启动/登录时自动升级到这里
     sha256:<64位hex>                   ← 旧格式，仍可校验，登录成功后自动换成 scrypt
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
const AUTH_COOKIE = 'luma_auth';
const AUTH_TTL_SEC = Math.max(3600, num(process.env.AUTH_TTL_SEC, 30 * 86400));
/* 配了固定密钥，服务重启后登录态仍然有效；不配则每次重启都要重新登录。 */
const AUTH_SECRET_RAW = str(process.env.AUTH_SECRET);

const SESSION_SECRET = AUTH_SECRET_RAW
  ? crypto.createHash('sha256').update(`luma-session\0${AUTH_SECRET_RAW}`).digest()
  : crypto.randomBytes(32);

/* 口令尝试限速：按来源 IP 计数，连续失败若干次锁一段时间。
   公网上的 /api/auth 和换票接口都算一次尝试，防止离线爆破。 */
const AUTH_MAX_FAILS = Math.max(1, num(process.env.AUTH_MAX_FAILS, 5));
const AUTH_LOCK_MS = Math.max(0, num(process.env.AUTH_LOCK_MS, 60_000));
const AUTH_MAP_MAX = 1000;

/* 默认只认 socket 地址（伪造不了）。跑在 Caddy / Nginx / 平台反代后面时
   所有请求的来源都是代理本身，要设 TRUST_PROXY=1 才读 X-Forwarded-For。 */
const TRUST_PROXY = bool(process.env.TRUST_PROXY);

/* 对外恒为 HTTPS 的部署（如 CDN 回源走 HTTP 的 Flexible SSL）可强制加 Secure，
   不依赖回源协商出来的 X-Forwarded-Proto。 */
const FORCE_SECURE_COOKIE = bool(process.env.COOKIE_SECURE);

/* ------------------------------------------------------------------ 直播与聊天 */

/* 主播 SSE 掉线后的宽限期：媒体连接独立于信令，SSE 断了画面还在，
   只要主播在宽限期内重连回来，这场直播就不该被判死。 */
const HOST_GRACE_MS = Math.max(0, num(process.env.HOST_GRACE_MS, 10000));

const CHAT_MIN_INTERVAL = Math.max(0, num(process.env.CHAT_MIN_INTERVAL, 350));
const CHAT_RATE_MAP_MAX = 1000;

/* ------------------------------------------------------------------ SSE */

const SSE_QUEUE_MAX = 256 * 1024;
const SSE_TICKET_TTL_MS = 60 * 1000;
const SSE_TICKET_MAX = 200;

/* ------------------------------------------------------------------ TURN */

/* 一条线路 = 一个 TURN 入口。TURN_LINES 用 `id|host|port|secret|标题` 描述，
   多条用逗号分隔；secret 留空表示匿名中继。
   凭证按 coturn 的 REST 方式（static-auth-secret）用 HMAC-SHA1 现签，6 小时有效。 */
const TURN_TTL_SEC = 6 * 60 * 60;
const TURN_USER = 'luma';

function parseTurnLines(raw) {
  return String(raw || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [id, host, port, secret, title] = x.split('|').map((v) => str(v));
      return { id: id || host, host, port: port || '3478', secret, title: title || id || host };
    })
    .filter((l) => l.host);
}

const TURN_LINES = parseTurnLines(process.env.TURN_LINES);

/* 兼容老部署：只配了 TURN_HOST / TURN_EXTRA 时，把它们转成线路 */
const TURN_HOST = str(process.env.TURN_HOST);
const TURN_PORT = str(process.env.TURN_PORT, '3478');
const TURN_STATIC_AUTH_SECRET = str(process.env.TURN_STATIC_AUTH_SECRET);
const TURN_LABEL = str(process.env.TURN_LABEL);
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

/* 默认线路：TURN_DEFAULT 填线路 id；不设就用第一条 TURN 线路 */
const TURN_DEFAULT = str(process.env.TURN_DEFAULT);
/* 中继线路固定为配置里的第一条。名字交给 TURN_LINES 的标题决定，
   代码里不写死城市名——换机房只改环境变量。 */
const RELAY_LINE = TURN_LINES[0] || null;
const RELAY_TITLE = (RELAY_LINE && RELAY_LINE.title) || '中继';

/* 不再保留默认兜底：只有一条 relay 线路，失败就停在未连接，不换路。 */
const DEFAULT_STUN = [];

module.exports = {
  PORT,
  PUBLIC_DIR,
  STREAM_KEY,

  DATA_DIR,
  USER_FILE,
  AVATAR_DIR,
  USER_FILE_MAX,
  AVATAR_MAX_BYTES,
  ALLOWED_AVATAR_EXT,

  AUTH_SEED,
  AUTH_COOKIE,
  AUTH_TTL_SEC,
  AUTH_SECRET_RAW,
  AUTH_MAX_FAILS,
  AUTH_LOCK_MS,
  AUTH_MAP_MAX,
  SESSION_SECRET,
  TRUST_PROXY,
  FORCE_SECURE_COOKIE,
  parseAuthUsers,

  HOST_GRACE_MS,
  CHAT_MIN_INTERVAL,
  CHAT_RATE_MAP_MAX,

  SSE_QUEUE_MAX,
  SSE_TICKET_TTL_MS,
  SSE_TICKET_MAX,

  TURN_LINES,
  TURN_DEFAULT,
  TURN_TTL_SEC,
  TURN_USER,
  RELAY_LINE,
  RELAY_TITLE,
  DEFAULT_STUN,
  parseTurnLines
};
