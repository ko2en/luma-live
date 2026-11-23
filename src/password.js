'use strict';

/**
 * 密码摘要：scrypt（随机盐）+ 老格式兼容。
 *
 * 支持的记录格式：
 *   scrypt:<N>:<r>:<p>:<salt>:<hash>   ← 当前算法
 *   sha256:<64位hex>                   ← 旧格式，登录成功后自动升级
 *   <明文>                             ← 更早的部署，登录成功后自动升级
 */

const crypto = require('crypto');
const { safeEqual } = require('./util');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, salt: 16 };
const SCRYPT_RE = /^scrypt:(\d+):(\d+):(\d+):([a-f0-9]{16,128}):([a-f0-9]{32,256})$/i;

function scryptEncode(pass, salt) {
  const key = crypto.scryptSync(String(pass), salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString('hex')}:${key.toString('hex')}`;
}

/* 同步版只用在启动种子（一次性，用户数量很少） */
function hashCredentialSync(pass) {
  return scryptEncode(pass, crypto.randomBytes(SCRYPT.salt));
}

/* 异步版给登录改写用：不让 scrypt 的计算卡住事件循环 */
function hashCredential(pass) {
  const salt = crypto.randomBytes(SCRYPT.salt);
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pass), salt, SCRYPT.keylen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => {
        if (err) return reject(err);
        resolve(`scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString('hex')}:${key.toString('hex')}`);
      });
  });
}

function looksHashed(cred) {
  return SCRYPT_RE.test(String(cred || '')) || /^sha256:[a-f0-9]{64}$/i.test(String(cred || ''));
}

/* 返回 { ok, legacy }：legacy=true 表示这条记录还是旧格式，登录后应升级 */
function verifyCredential(stored, input) {
  const s = String(stored || '');
  const m = SCRYPT_RE.exec(s);
  if (m) {
    const N = Number(m[1]);
    const r = Number(m[2]);
    const p = Number(m[3]);
    const salt = Buffer.from(m[4], 'hex');
    const want = Buffer.from(m[5], 'hex');
    return new Promise((resolve) => {
      crypto.scrypt(String(input || ''), salt, want.length, { N, r, p }, (err, key) => {
        if (err) return resolve({ ok: false, legacy: false });
        resolve({ ok: safeEqual(key.toString('hex'), want.toString('hex')), legacy: false });
      });
    });
  }
  const legacySha = /^sha256:([a-f0-9]{64})$/i.exec(s);
  if (legacySha) {
    const got = crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
    return Promise.resolve({ ok: safeEqual(got, legacySha[1].toLowerCase()), legacy: true });
  }
  /* 还没升级的老部署：明文口令 */
  return Promise.resolve({ ok: Boolean(s) && safeEqual(String(input || ''), s), legacy: Boolean(s) });
}

/* 账号不存在时也走一次同样耗时的校验，避免用响应时间枚举用户名 */
const DUMMY_CRED = hashCredentialSync(crypto.randomBytes(16).toString('hex'));

module.exports = {
  SCRYPT,
  hashCredential,
  hashCredentialSync,
  looksHashed,
  verifyCredential,
  DUMMY_CRED
};
