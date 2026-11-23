#!/usr/bin/env node
'use strict';

/**
 * 生成 AUTH_USERS / users.json 里可用的密码摘要。
 *
 *   node scripts/hash-pass.js '你的密码'
 *
 * 输出形如 scrypt:16384:8:1:<salt>:<hash>，可直接写进 AUTH_USERS：
 *   AUTH_USERS="主播:scrypt:16384:8:1:..."
 * 服务端也能校验旧的 sha256: 与明文，会在一次成功登录后自动升级。
 */

const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, salt: 16 };

const pass = process.argv.slice(2).join(' ');
if (!pass) {
  console.error('用法：node scripts/hash-pass.js <明文密码>');
  process.exit(1);
}

const salt = crypto.randomBytes(SCRYPT.salt);
const key = crypto.scryptSync(pass, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
console.log(`scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString('hex')}:${key.toString('hex')}`);
