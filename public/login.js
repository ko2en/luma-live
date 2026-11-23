'use strict';

(function () {
  var form = document.querySelector('[data-login]');
  var err = document.querySelector('[data-error]');
  var submit = document.querySelector('[data-submit]');
  if (!form) return;

  function setError(msg) { if (err) err.textContent = msg || ''; }

  /* 只允许站内相对路径的 next，杜绝 open redirect。 */
  function safeNext() {
    var raw = new URLSearchParams(location.search).get('next') || '/';
    if (raw.charAt(0) !== '/' || raw.charAt(1) === '/') return '/';
    return raw;
  }

  /* 已经登录就直接放行，别让人重复登录。 */
  fetch('/api/me', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (me) {
      if (me && !me.requireLogin) location.replace(safeNext());
      else if (me && me.authenticated) location.replace(safeNext());
    })
    .catch(function () { /* 忽略：继续显示登录框 */ });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    setError('');
    var user = form.user.value.trim();
    var pass = form.pass.value;
    if (!user || !pass) { setError('请填写账号和密码'); return; }
    if (submit) { submit.disabled = true; submit.textContent = '登录中…'; }

    fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: user, pass: pass })
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          return { status: r.status, data: data, retryAfter: r.headers.get('Retry-After') };
        });
      })
      .then(function (out) {
        if (out.status === 200 && out.data.ok) {
          location.replace(safeNext());
          return;
        }
        var msg = (out.data && out.data.error) || '登录失败，请重试';
        if (out.status === 429) msg = '尝试太频繁，' + (out.retryAfter || '几') + ' 秒后再试';
        setError(msg);
        if (submit) { submit.disabled = false; submit.textContent = '登 录'; }
        form.pass.select();
      })
      .catch(function () {
        setError('网络异常，请重试');
        if (submit) { submit.disabled = false; submit.textContent = '登 录'; }
      });
  });
})();
