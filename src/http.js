'use strict';

/**
 * HTTP 层的小工具：JSON 响应、请求体读取、安全响应头、cookie 追加、静态文件。
 * 这里不碰业务状态，只处理 Node 的 req/res。
 */

const fs = require('fs');
const path = require('path');

const { PUBLIC_DIR, TRUST_PROXY, FORCE_SECURE_COOKIE } = require('./config');

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
}/* 一个请求可能同时种 session 和 auth 两个 cookie，append 而不是覆盖。 */
function addCookie(res, line) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', line);
  else if (Array.isArray(prev)) res.setHeader('Set-Cookie', prev.concat(line));
  else res.setHeader('Set-Cookie', [prev, line]);
}

function secureCookie(req) {
  if (FORCE_SECURE_COOKIE) return true;
  if (req.socket.encrypted) return true;
  if (TRUST_PROXY) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (proto === 'https') return true;
  }
  return false;
}

/* 请求是不是走的 HTTPS：直连 TLS、或者反代给了 X-Forwarded-Proto */
function isHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
}

/* 页面里没有内联脚本，所以 script-src 不用开 unsafe-inline；
   style 与字体得放开：界面用 style 标签排版，中文走 npmmirror 的文楷。 */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "style-src 'self' 'unsafe-inline' https://registry.npmmirror.com",
  "font-src 'self' data: https://registry.npmmirror.com",
  "script-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "connect-src 'self'"
].join('; ');

const PERMISSIONS_POLICY = [
  'camera=(self)', 'microphone=(self)', 'display-capture=(self)',
  'geolocation=()', 'payment=()', 'usb=()'
].join(', ');

function applySecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  /* 只在确实跑在 HTTPS 上时才发 HSTS：源站走 http 反代时发它会把用户锁死 */
  if (isHttps(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
}

/* Cookie 已经是 SameSite=Strict，跨站请求本来带不上。
   这里再挡一层显式带着别人的 Origin/Referer 来的写请求，防止反代或老浏览器把 SameSite 丢掉。
   两个头都没有（curl、同源表单、部分旧浏览器）就放行，交给 cookie 兜底。 */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function crossSiteWrite(req, pathname) {
  if (!UNSAFE_METHODS.has(req.method)) return false;
  if (!pathname.startsWith('/api/')) return false;
  const source = req.headers.origin || req.headers.referer || '';
  if (!source) return false;
  const host = String(req.headers.host || '').toLowerCase();
  try {
    return new URL(source).host.toLowerCase() !== host;
  } catch (err) {
    return true; /* Origin: null 之类解析不了的头，直接按跨站处理 */
  }
}

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

module.exports = {
  MIME,
  json,
  readBody,
  addCookie,
  secureCookie,
  isHttps,
  applySecurityHeaders,
  crossSiteWrite,
  serveStatic
};
