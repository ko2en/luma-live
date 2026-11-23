#!/usr/bin/env node
'use strict';

/**
 * LUMA Live 部署自检。
 *
 *   npm run doctor
 *
 * 只读检查，不修改任何文件，也不打印密钥。
 * 退出码：0 全部通过（可能有提醒）；1 存在必须处理的问题。
 */

const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.LUMA_DATA_DIR || path.join(ROOT, 'data'));
const USER_FILE = path.join(DATA_DIR, 'users.json');

let ok = 0;
let warn = 0;
let fail = 0;

const C = process.stdout.isTTY
  ? { g: '\u001b[32m', y: '\u001b[33m', r: '\u001b[31m', d: '\u001b[2m', x: '\u001b[0m' }
  : { g: '', y: '', r: '', d: '', x: '' };

function pass(msg) { ok += 1; console.log(`${C.g}✓${C.x} ${msg}`); }
function soft(msg) { warn += 1; console.log(`${C.y}!${C.x} ${msg}`); }
function bad(msg) { fail += 1; console.log(`${C.r}✗${C.x} ${msg}`); }
function note(msg) { console.log(`  ${C.d}${msg}${C.x}`); }

/* ---------------------------------------------------------------- 运行时 */

const major = Number(process.versions.node.split('.')[0]);
if (major >= 18) pass(`Node.js ${process.versions.node}`);
else bad(`Node.js ${process.versions.node} 太旧，需要 ≥ 18`);

if (fs.existsSync(path.join(ROOT, 'server.js')) && fs.existsSync(path.join(ROOT, 'public'))) {
  pass('server.js 与 public/ 就位');
} else {
  bad('当前目录不像 LUMA Live 根目录（缺 server.js 或 public/）');
}

/* ---------------------------------------------------------------- 数据目录 */

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
  pass(`数据目录可写 ${DATA_DIR}`);
} catch (err) {
  bad(`数据目录不可写 ${DATA_DIR}（${err.code || err.message}）`);
}

const hasAccounts = fs.existsSync(USER_FILE);
const seed = String(process.env.AUTH_USERS || '').trim();

if (hasAccounts) {
  pass(`账号库存在 ${path.relative(ROOT, USER_FILE)}`);
  if (seed) note('AUTH_USERS 只在首次启动时作为种子，之后以 users.json 为准，改了不会覆盖现有账号');
} else if (seed) {
  pass('AUTH_USERS 已配置（首次启动会写入 users.json）');
  if (!/^[^:,\s]+:.+/.test(seed)) soft('AUTH_USERS 格式看起来不对，应为 用户名:密码[,用户名:密码]');
  if (seed.includes('请替换') || seed.includes('changeme') || seed.includes('password')) {
    bad('AUTH_USERS 里还是示例密码，公网部署前务必改成强密码');
  }
} else {
  soft('没有账号也没有 AUTH_USERS：登录鉴权是关闭的，任何能访问页面的人都能开播');
  note('公网部署请设置 AUTH_USERS，或退回 STREAM_KEY 口令模式');
}

/* ---------------------------------------------------------------- 会话与传输 */

const secret = String(process.env.AUTH_SECRET || '').trim();
if (secret.length >= 32) pass('AUTH_SECRET 已配置');
else if (secret) soft('AUTH_SECRET 偏短，建议至少 32 字符（openssl rand -hex 32）');
else soft('未设置 AUTH_SECRET：服务重启后所有人需要重新登录');

if (String(process.env.COOKIE_SECURE || '') === '1') pass('COOKIE_SECURE=1（cookie 只走 HTTPS）');
else {
  soft('未设置 COOKIE_SECURE：如果站点跑在 HTTPS 上，建议设为 1');
  note('若通过 Cloudflare / 反代提供 HTTPS，同时要设 TRUST_PROXY=1 才能正确识别来源');
}

if (['1', 'true'].includes(String(process.env.TRUST_PROXY || ''))) {
  pass('TRUST_PROXY 已启用（读 X-Forwarded-For）');
  note('必须确保源站端口只对反代开放，否则来源 IP 可被伪造');
}

/* ---------------------------------------------------------------- TURN */

function parseTurnLines(raw) {
  return String(raw || '')
    .split(',')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const parts = chunk.split('|');
      return {
        id: (parts[0] || '').trim(),
        host: (parts[1] || '').trim(),
        port: (parts[2] || '3478').trim(),
        secret: (parts[3] || '').trim(),
        title: (parts[4] || '').trim()
      };
    });
}

const lines = parseTurnLines(process.env.TURN_LINES);
if (!lines.length) {
  if (String(process.env.TURN_HOST || '').trim()) {
    pass(`TURN 使用旧变量 TURN_HOST=${process.env.TURN_HOST}`);
    soft('旧变量仍可用，但建议迁到 TURN_LINES="id|host|port|secret|标题"');
  } else {
    bad('没有配置 TURN：浏览器只能拿到空 iceServers，观众必然连不上');
    note('跑 sudo bash scripts/setup-turn.sh，或用 TURN_LINES 指定已有中继');
  }
} else {
  const first = lines[0];
  if (!first.host) bad('TURN_LINES 第一条没有 host');
  else pass(`TURN 线路 ${first.id || '(无 id)'} → ${first.host}:${first.port}`);
  if (lines.length > 1) soft(`配置了 ${lines.length} 条线路，当前只用第一条`);
  if (!first.secret) soft('线路没有 secret：coturn 需要匿名中继或静态凭证才能用');
  if (first.host === 'turn.example.com') bad('TURN host 还是示例域名，改成真实地址');
}

/* ---------------------------------------------------------------- 端口 */

const port = Number(process.env.PORT || 3000);
const probe = net.createServer();
probe.once('error', (err) => {
  if (err.code === 'EADDRINUSE') soft(`端口 ${port} 已被占用（服务可能已经在跑）`);
  else soft(`端口 ${port} 无法绑定：${err.code}`);
  finish();
});
probe.once('listening', () => {
  pass(`端口 ${port} 空闲`);
  probe.close(() => finish());
});
probe.listen(port, '0.0.0.0');

/* ---------------------------------------------------------------- 汇总 */

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  console.log('');
  console.log(`结果：${ok} 项通过，${warn} 项提醒，${fail} 项失败`);
  if (fail > 0) {
    console.log('先修掉 ✗ 的项再开播。');
    process.exit(1);
  }
  console.log('可以启动：node server.js');
}
