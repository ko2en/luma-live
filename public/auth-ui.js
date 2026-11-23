'use strict';

/* 顶栏账号区：头像 + 账号名 + 设置 + 退出。
   与 viewer.js / studio.js 完全解耦，只操作 [data-auth] 容器。
   未启用登录时整块隐藏。设置弹窗支持改账号、改密码、上传头像。 */
(function () {
  var box = document.querySelector('[data-auth]');
  if (!box) return;

  var me = null;
  var avatarUrl = '';
  var pendingAvatar = '';

  function paintAvatar(img, url, name) {
    if (!img) return;
    if (url) {
      img.src = url;
      img.hidden = false;
      if (img.nextElementSibling) img.nextElementSibling.hidden = true;
    } else {
      img.hidden = true;
      if (img.nextElementSibling) {
        img.nextElementSibling.hidden = false;
        img.nextElementSibling.textContent = (name || '?').slice(0, 1).toUpperCase();
      }
    }
  }

  function build() {
    box.replaceChildren();

    var img = document.createElement('img');
    img.className = 'auth-avatar';
    img.alt = '';
    var initial = document.createElement('span');
    initial.className = 'auth-initial';
    var wrap = document.createElement('span');
    wrap.className = 'auth-avatar-wrap';
    wrap.appendChild(img);
    wrap.appendChild(initial);
    paintAvatar(img, avatarUrl, me.user);

    var name = document.createElement('span');
    name.className = 'auth-user';
    name.textContent = me.user || '已登录';
    name.title = '当前授信账号';

    var settings = document.createElement('button');
    settings.className = 'auth-settings';
    settings.type = 'button';
    settings.textContent = '设置';
    settings.title = '修改账号 / 密码 / 头像';
    settings.addEventListener('click', openSettings);

    var out = document.createElement('button');
    out.className = 'auth-out';
    out.type = 'button';
    out.textContent = '退出';
    out.title = '退出登录';
    out.addEventListener('click', function () {
      fetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
        .then(function () { location.replace('/login'); })
        .catch(function () { location.replace('/login'); });
    });

    box.appendChild(wrap);
    box.appendChild(name);
    box.appendChild(settings);
    box.appendChild(out);
    box.hidden = false;
  }

  /* ---------------- 设置弹窗 ---------------- */
  var mask = null;
  var hint = null;

  function say(text, isError) {
    if (!hint) return;
    hint.textContent = text;
    hint.className = 'set-hint' + (isError ? ' is-error' : ' is-ok');
  }

  function closeSettings() {
    if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
    mask = null;
    hint = null;
    pendingAvatar = '';
  }

  function field(label, node) {
    var row = document.createElement('label');
    row.className = 'set-field';
    var span = document.createElement('span');
    span.textContent = label;
    row.appendChild(span);
    row.appendChild(node);
    return row;
  }

  function openSettings() {
    closeSettings();
    mask = document.createElement('div');
    mask.className = 'set-mask';

    var panel = document.createElement('div');
    panel.className = 'set-panel';

    var head = document.createElement('div');
    head.className = 'set-head';
    var title = document.createElement('h2');
    title.textContent = '账号设置';
    var close = document.createElement('button');
    close.className = 'set-close';
    close.type = 'button';
    close.textContent = '×';
    close.title = '关闭';
    close.addEventListener('click', closeSettings);
    head.appendChild(title);
    head.appendChild(close);
    panel.appendChild(head);

    var currentPass = document.createElement('input');
    currentPass.type = 'password';
    currentPass.placeholder = '请输入当前密码';
    currentPass.maxLength = 128;
    currentPass.autocomplete = 'current-password';

    var newUser = document.createElement('input');
    newUser.type = 'text';
    newUser.placeholder = '不修改请留空';
    newUser.maxLength = 24;

    var newPass = document.createElement('input');
    newPass.type = 'password';
    newPass.placeholder = '至少 6 位，不修改请留空';
    newPass.maxLength = 128;
    newPass.autocomplete = 'new-password';

    var avatarRow = document.createElement('div');
    avatarRow.className = 'set-avatar-row';
    var preview = document.createElement('img');
    preview.className = 'set-avatar-preview';
    preview.alt = '';
    var previewInitial = document.createElement('span');
    previewInitial.className = 'set-avatar-initial';
    previewInitial.textContent = (me.user || '?').slice(0, 1).toUpperCase();
    if (avatarUrl) { preview.src = avatarUrl; }
    else { preview.hidden = true; }
    previewInitial.hidden = Boolean(avatarUrl);
    var file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/png,image/jpeg,image/webp';
    file.className = 'set-file';
    var fileLabel = document.createElement('span');
    fileLabel.className = 'set-file-btn';
    fileLabel.textContent = '选择图片';
    fileLabel.appendChild(file);
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      if (!f) return;
      if (f.size > 512 * 1024) { say('图片不能超过 512KB', true); file.value = ''; return; }
      var reader = new FileReader();
      reader.onload = function () {
        pendingAvatar = String(reader.result);
        preview.src = pendingAvatar;
        preview.hidden = false;
        previewInitial.hidden = true;
        say('图片已选择，点保存生效', false);
      };
      reader.readAsDataURL(f);
    });
    avatarRow.appendChild(preview);
    avatarRow.appendChild(previewInitial);
    avatarRow.appendChild(fileLabel);

    hint = document.createElement('div');
    hint.className = 'set-hint';

    var actions = document.createElement('div');
    actions.className = 'set-actions';
    var save = document.createElement('button');
    save.className = 'set-save';
    save.type = 'button';
    save.textContent = '保存';
    var cancel = document.createElement('button');
    cancel.className = 'set-cancel';
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', closeSettings);
    actions.appendChild(save);
    actions.appendChild(cancel);

    panel.appendChild(field('头像', avatarRow));
    panel.appendChild(field('新账号', newUser));
    panel.appendChild(field('新密码', newPass));
    panel.appendChild(field('当前密码（必填）', currentPass));
    panel.appendChild(hint);
    panel.appendChild(actions);
    mask.appendChild(panel);
    mask.addEventListener('click', function (e) { if (e.target === mask) closeSettings(); });
    document.body.appendChild(mask);
    newUser.focus();

    save.addEventListener('click', function () {
      if (!currentPass.value) { say('请输入当前密码', true); currentPass.focus(); return; }
      var accBody = { currentPass: currentPass.value };
      var un = newUser.value.trim();
      if (un && un !== me.user) accBody.newUser = un;
      if (newPass.value) accBody.newPass = newPass.value;
      var jobs = [];
      if (accBody.newUser || accBody.newPass) {
        jobs.push(fetch('/api/account', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(accBody)
        }).then(toResult));
      }
      if (pendingAvatar) {
        jobs.push(fetch('/api/avatar', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: pendingAvatar })
        }).then(toResult));
      }
      if (!jobs.length) { say('没有需要保存的修改', true); return; }

      save.disabled = true;
      save.textContent = '保存中…';
      Promise.all(jobs).then(function (results) {
        var bad = results.find(function (x) { return !x.ok; });
        if (bad) {
          say(bad.j && bad.j.error ? bad.j.error : '保存失败', true);
          save.disabled = false;
          save.textContent = '保存';
          return;
        }
        var gotUser = me.user;
        var gotAvatar = avatarUrl;
        results.forEach(function (x) {
          if (x.j && x.j.user) gotUser = x.j.user;
          if (x.j && x.j.avatar) gotAvatar = x.j.avatar;
        });
        me.user = gotUser;
        avatarUrl = gotAvatar;
        build();
        say('已保存', false);
        if (window.dispatchEvent && window.CustomEvent) {
          window.dispatchEvent(new CustomEvent('luma:account', {
            detail: { user: me.user, avatar: avatarUrl }
          }));
        }
        setTimeout(closeSettings, 700);
      }).catch(function () {
        say('网络错误，请重试', true);
        save.disabled = false;
        save.textContent = '保存';
      });
    });
  }

  function toResult(r) {
    return r.json().then(function (j) { return { ok: r.ok, j: j }; });
  }

  fetch('/api/me', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data || !data.requireLogin) { box.hidden = true; return; }
      if (!data.authenticated) { location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search)); return; }
      me = data;
      avatarUrl = data.avatar || '';
      build();
    })
    .catch(function () { box.hidden = true; });
})();
