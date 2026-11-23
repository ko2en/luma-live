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

/* 配置集中在一处：只允许 src/config.js 读 process.env */
const config = require('./src/config');
const { safeEqual } = require('./src/util');
const { pickLine, icePayload } = require('./src/turn');
const {
  json, readBody, addCookie, secureCookie,
  applySecurityHeaders, crossSiteWrite, serveStatic
} = require('./src/http');
const {
  clients, accountConns, chatLog, lastChatAt, nextChatSeq, stream, supersededHosts,
  noteSuperseded, clearHostGrace, startHostGrace, viewerDescriptors, statePayload,
  writeSse, sendTo, broadcast, broadcastState, startHeartbeat, evictAccount, closeAll, colorFor,
  issueSseTicket, takeSseTicket
} = require('./src/live');
const { hashCredential, verifyCredential, DUMMY_CRED } = require('./src/password');
const {
  USER_DB, saveUserFile, validUserName, validAvatarFile, sniffImage, avatarUrlOf, AUTH_ENABLED
} = require('./src/users');
const {
  PORT, PUBLIC_DIR, STREAM_KEY,
  DATA_DIR, AVATAR_DIR, AVATAR_MAX_BYTES, ALLOWED_AVATAR_EXT,
  AUTH_COOKIE, AUTH_TTL_SEC, AUTH_SECRET_RAW, AUTH_MAX_FAILS, AUTH_LOCK_MS, AUTH_MAP_MAX,
  SESSION_SECRET, TRUST_PROXY, FORCE_SECURE_COOKIE,
  HOST_GRACE_MS, CHAT_MIN_INTERVAL, CHAT_RATE_MAP_MAX,
  SSE_QUEUE_MAX, SSE_TICKET_TTL_MS, SSE_TICKET_MAX,
  TURN_LINES, RELAY_LINE, RELAY_TITLE, DEFAULT_STUN
} = config;

/* ---------------- 授信用户登录（白名单账号 + 签名 cookie） ----------------
   AUTH_USERS 格式：`用户名:密码[,用户名:密码 ...]`
   密码可以写明文，也可以写摘要（`node scripts/hash-pass.js 明文` 生成）：
     scrypt:<N>:<r>:<p>:<salt>:<hash>   ← 当前算法，首次启动/登录时自动升级到这里
     sha256:<64位hex>                   ← 旧格式，仍可校验，登录成功后自动换成 scrypt
   一旦配了账号，全站（观看页 / 开播台 / 所有 API / SSE）都必须先登录。
   不配则维持旧的公开模式 + 可选开播口令，方便本机和已有部署平滑升级。 */

/* 账号库见 src/users.js：内存 Map + users.json 原子写，头像文件放 DATA_DIR/avatars */


/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */


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

/* 密码摘要实现见 src/password.js（scrypt + 老格式透明升级） */

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
/* TURN 线路与凭证见 src/turn.js */


/* 状态广播做合并：观众成批涌入时（一次转发带来几十个新连接），
   每个连接都广播一次会变成 O(N²) 写入。这里把窗口内的多次请求
   合并成一帧，延迟 200ms 完全不影响观感。 */


/* ------------------------------------------------------------------ *
 * SSE
 * ------------------------------------------------------------------ */


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
    /* 登录模式：全局闸门已经验过 cookie，这里不用再验。
       口令模式：必须拿 POST /api/sse-ticket 换来的票据，URL 里不再接受口令。 */
    if (!AUTH_ENABLED) {
      const legacyKey = url.searchParams.get('key');
      if (legacyKey) {
        return json(res, 401, {
          error: '开播凭证已改为短期票据，请刷新页面',
          code: 'ticket-required'
        });
      }
      const ticket = takeSseTicket(url.searchParams.get('ticket'), 'host', id);
      if (!ticket) {
        return json(res, 401, { error: '票据无效或已过期，请刷新页面重试', code: 'ticket-required' });
      }
    } else {
      takeSseTicket(url.searchParams.get('ticket'), 'host', id); /* 有就顺手核销掉 */
    }

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

    /* 用户名不存在也走一次同样耗时的校验，避免用响应耗时枚举账号。 */
    const chk = await verifyCredential(cred || DUMMY_CRED, pass);
    if (!chk.ok || !cred) {
      noteAuthFail(req);
      return json(res, 401, { ok: false, error: '账号或密码不正确' });
    }
    clearAuthFail(req);
    /* 老的 sha256 / 明文记录：登录成功即就地换成 scrypt */
    if (chk.legacy) {
      try {
        USER_DB.get(user).cred = await hashCredential(pass);
        saveUserFile();
      } catch (err) { /* 升级失败不影响本次登录 */ }
    }
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
    if (!(await verifyCredential(rec.cred, currentPass)).ok) {
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

    if (wantPass) rec.cred = await hashCredential(newPass);
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

  /* 连接诊断用：现签一份 ICE 配置给前端自己做候选收集。
     浏览器只能从「能不能拿到 relay 候选」判断中继是否可用，服务端不参与探测。 */
  if (req.method === 'GET' && route === '/api/ice') {
    return json(res, 200, { ice: icePayload(), now: Date.now() });
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

  /* 用一次口令/登录态换一张 SSE 票据。口令只走 POST body，不进任何 URL。 */
  if (req.method === 'POST' && route === '/api/sse-ticket') {
    let body;
    try { body = await readBody(req); } catch (err) { return json(res, 400, { error: 'bad body' }); }
    const role = body && body.role === 'host' ? 'host' : 'viewer';
    const id = String((body && body.id) || '').slice(0, 64);
    if (!id) return json(res, 400, { error: 'missing id' });

    if (role === 'host' && !AUTH_ENABLED) {
      const left = authLockLeft(req);
      if (left > 0) return tooMany(res, left);
      if (!keyOk(String((body && body.key) || ''))) {
        noteAuthFail(req);
        return json(res, 401, { error: '开播口令不正确' });
      }
      clearAuthFail(req);
    }

    const user = AUTH_ENABLED ? authUserOf(req) : null;
    if (role === 'host' && AUTH_ENABLED && !user) return json(res, 401, { error: '请先登录' });
    const ticket = issueSseTicket(role, id, req.session, user);
    return json(res, 200, { ok: true, ticket, expiresIn: SSE_TICKET_TTL_MS / 1000 });
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
      id: `m${nextChatSeq()}`,
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
 * 就绪检查（安全响应头与跨站校验见 src/http.js）
 * ------------------------------------------------------------------ */

function readiness() {
  const checks = {};
  let ok = true;
  if (shuttingDown) { checks.server = 'shutting-down'; ok = false; }
  else checks.server = 'ok';

  try {
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    checks.dataDir = 'writable';
  } catch (err) {
    checks.dataDir = 'not-writable';
    ok = false;
  }

  if (AUTH_ENABLED) checks.auth = `accounts:${USER_DB.size}`;
  else if (STREAM_KEY) checks.auth = 'stream-key';
  else checks.auth = 'open';

  checks.turn = RELAY_LINE ? `${RELAY_LINE.id}@${RELAY_LINE.host}:${RELAY_LINE.port}` : 'none';
  checks.live = Boolean(stream.live);
  checks.clients = clients.size;
  checks.uptime = Math.round(process.uptime());
  return { ok, checks };
}

/* ------------------------------------------------------------------ *
 * server
 * ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  applySecurityHeaders(req, res);
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    decodeURIComponent(url.pathname);
  } catch (err) {
    return json(res, 400, { error: 'bad URI' });
  }
  req.session = sessionOf(req, res);

  /* 健康检查放在鉴权之前：反代、systemd、uptime 探针都不带 cookie */
  if (url.pathname === '/healthz') {
    return json(res, 200, { ok: true, uptime: Math.round(process.uptime()), pid: process.pid });
  }
  if (url.pathname === '/readyz') {
    const r = readiness();
    return json(res, r.ok ? 200 : 503, r);
  }

  if (crossSiteWrite(req, url.pathname)) {
    return json(res, 403, { error: '跨站请求已拒绝', code: 'cross-site' });
  }

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
      if (process.env.LUMA_DEBUG) console.error('[api]', err);
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

/* 优雅退出：先把「服务器要重启」推给在线页面，再关 SSE、清房间状态。
   否则 systemd / Docker 重启时，客户端只会看到 EventSource 无声断开，
   前端要等自动重连超时才反应过来。 */
let shuttingDown = false;

/* 退出日志走同步写：接管道（systemd / docker）时 console.log 是异步的，
   紧接着 process.exit() 会把还没刷出去的日志吞掉，journalctl 里就看不到退出了。 */
function logSync(line) {
  try { fs.writeSync(1, `${line}\n`); } catch (err) { /* fd 1 不可写就算了 */ }
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logSync(`收到 ${signal}，开始优雅退出（在线连接 ${clients.size} 个）`);
  closeAll();
  server.close(() => process.exit(0));
  const force = setTimeout(() => process.exit(0), 2000);
  if (force.unref) force.unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

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
