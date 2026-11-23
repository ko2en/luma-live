'use strict';

/**
 * 直播间运行态：在线连接、SSE 广播、聊天记录、主播断线宽限。
 *
 * 全部是进程内状态，重启即清空 —— 直播本来就是这样，不要用多实例跑。
 * 单进程里 server.js 直接引用这里导出的 Map/对象（同一个引用），
 * 所以「读状态、改状态」不需要额外的转发函数。
 */

const {
  RELAY_LINE, RELAY_TITLE, SSE_QUEUE_MAX,
  SSE_TICKET_TTL_MS, SSE_TICKET_MAX, HOST_GRACE_MS
} = require('./config');
const crypto = require('crypto');
const { avatarUrlOf } = require('./users');

/* 昵称配色跟随主站：墨黑 / 朱红 / 灰阶 */
const PALETTE = [
  '#111111', '#e8462f', '#4a4a4a', '#8a8a86', '#c6371f',
  '#2c2c2c', '#6b6b66', '#a5a5a0', '#7a3b30', '#3f3f3c'
];

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

function colorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const sseTickets = new Map(); // token -> { role, id, session, user, exp }

function issueSseTicket(role, id, session, user) {
  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  for (const [k, v] of sseTickets) if (v.exp <= now) sseTickets.delete(k);
  while (sseTickets.size >= SSE_TICKET_MAX) {
    const oldest = sseTickets.keys().next().value;
    sseTickets.delete(oldest);
  }
  sseTickets.set(token, { role, id, session, user: user || '', exp: now + SSE_TICKET_TTL_MS });
  return token;
}

function takeSseTicket(token, role, id) {
  const key = String(token || '');
  if (!key) return null;
  const t = sseTickets.get(key);
  if (!t) return null;
  sseTickets.delete(key); /* 一次性：不管后面校验过不过，都用掉了 */
  if (t.exp <= Date.now()) return null;
  if (role && t.role !== role) return null;
  if (id && t.id !== id) return null;
  return t;
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

/* 优雅退出：先告诉在线页面「服务器要重启」，再关连接、停定时器 */
function closeAll() {
  broadcast('server-shutdown', { reason: 'restart', at: Date.now() });
  for (const c of clients.values()) {
    try { c.res.end(); } catch (err) { /* noop */ }
  }
  clients.clear();
  accountConns.clear();
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
  if (hostGraceTimer) { clearTimeout(hostGraceTimer); hostGraceTimer = null; }
}

/* 聊天序号：由这里统一发号，避免 server.js 直接改本地变量 */
function nextChatSeq() {
  chatSeq += 1;
  return chatSeq;
}

module.exports = {
  clients,
  accountConns,
  chatLog,
  lastChatAt,
  nextChatSeq,
  stream,
  supersededHosts,
  colorFor,
  noteSuperseded,
  clearHostGrace,
  startHostGrace,
  viewerCount,
  viewerDescriptors,
  audienceList,
  statePayload,
  writeSse,
  sendTo,
  broadcast,
  broadcastState,
  startHeartbeat,
  evictAccount,
  closeAll,
  issueSseTicket,
  takeSseTicket
};
