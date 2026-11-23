'use strict';

/**
 * 可自助维护的账号库（用户名 / 密码摘要 / 头像）。
 *
 * env 的 AUTH_USERS 只是首次种子：第一次启动时写入 DATA_DIR/users.json，
 * 之后以文件为唯一真相 —— 用户可以在网页里改自己的账号、密码、头像。
 * 元数据文件放 DATA_DIR，头像放 DATA_DIR/avatars；均限制为本地路径。
 *
 * 单进程内存库：不要用 cluster / 多实例跑这个服务，否则各进程的账号缓存会打架。
 */

const fs = require('fs');

const {
  DATA_DIR, USER_FILE, AVATAR_DIR, USER_FILE_MAX, AUTH_SEED
} = require('./config');
const { looksHashed, hashCredentialSync } = require('./password');

/* name -> { cred, avatar }，cred 为 scrypt/sha256 摘要或明文；avatar 为纯文件名 `<hash>.<ext>` */
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
    /* 种子里写的是明文就就地哈希，别把明文落到 users.json 里 */
    for (const [name, cred] of AUTH_SEED) {
      USER_DB.set(name, { cred: looksHashed(cred) ? cred : hashCredentialSync(cred), avatar: '' });
    }
    if (USER_DB.size) {
      try { saveUserFile(); } catch (err) { console.error('账号库初始化失败：', err.message); }
    }
  }
}

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

loadUserFile();

/* 有没有账号决定整站的鉴权模式，必须在读库之后才能定 */
const AUTH_ENABLED = USER_DB.size > 0;

module.exports = {
  USER_DB,
  saveUserFile,
  loadUserFile,
  validUserName,
  validAvatarFile,
  sniffImage,
  avatarUrlOf,
  AUTH_ENABLED
};
