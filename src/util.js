'use strict';

const crypto = require('crypto');

/* 定时比较，避免逐字符短路泄漏口令长度/前缀 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch (err) { return false; }
}

module.exports = { safeEqual };
