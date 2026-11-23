'use strict';

/**
 * TURN 线路与凭证下发。
 *
 * 当前部署只有一条中继线路：`iceServers` 里只给这一条 TURN（UDP + TCP 各一条 url），
 * 并强制 `iceTransportPolicy: relay`，媒体必定经过中继，不做直连回退。
 * 凭证按 coturn 的 REST 方式（static-auth-secret）用 HMAC-SHA1 现签。
 */

const crypto = require('crypto');

const {
  TURN_LINES, TURN_DEFAULT, TURN_TTL_SEC, TURN_USER, RELAY_LINE, RELAY_TITLE
} = require('./config');

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

module.exports = { turnEntry, lineOptions, findLine, defaultLine, pickLine, icePayload };
