(() => {
  'use strict';

  /* ================= 基础 ================= */

  const $ = (sel, root = document) => root.querySelector(sel);
  const ICE = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ]
  };

  const el = {
    player: $('[data-player]'),
    video: $('[data-video]'),
    idle: $('[data-idle]'),
    idleTitle: $('[data-idle-title]'),
    idleSub: $('[data-idle-sub]'),
    badge: $('[data-live-badge]'),
    title: $('[data-title]'),
    titleEcho: $('[data-title-echo]'),
    streamer: $('[data-streamer]'),
    bio: $('[data-bio]'),
    avatar: $('[data-avatar]'),
    viewers: $('[data-viewers]'),
    viewers2: $('[data-viewers-2]'),
    uptime: $('[data-uptime]'),
    uptime2: $('[data-uptime-2]'),
    mutedNote: $('[data-muted-note]'),
    unmute: $('[data-unmute]'),
    chat: $('[data-chat]'),
    chatList: $('[data-chat-list]'),
    chatEmpty: $('[data-chat-empty]'),
    chatCount: $('[data-chat-count]'),
    chatForm: $('[data-chat-form]'),
    chatInput: $('[data-chat-input]'),
    sendBtn: $('[data-send]'),
    nameChip: $('[data-name]'),
    chatOpen: $('[data-chat-open]'),
    chatClose: $('[data-chat-close]'),
    fabBadge: $('[data-fab-badge]'),
    shareBtn: $('[data-share]'),
    toast: $('[data-toast]')
  };


  /* 部署环境带 sharecode，站内跳转必须保留 */
  function keepShareCode() {
    const q = location.search;
    if (!q) return;
    document.querySelectorAll('a[href^="/"]').forEach((a) => {
      const href = a.getAttribute('href');
      if (href && !href.includes('?')) a.setAttribute('href', href + q);
    });
  }
  keepShareCode();

  const uuid = () =>
    window.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : `v-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  const clientId = uuid();
  let nickname =
    (localStorage.getItem('luma:name') || '').trim() ||
    `访客·${1000 + Math.floor(Math.random() * 9000)}`;

  const state = {
    live: false,
    startedAt: null,
    hostId: null,
    viewers: 0,
    messages: 0
  };

  const seen = new Set();
  let toastTimer = null;
  let unread = 0;

  const isMobile = () => window.matchMedia('(max-width: 1080px)').matches;

  function bumpUnread() {
    if (!isMobile() || el.chat.classList.contains('is-open')) return;
    unread += 1;
    el.fabBadge.textContent = unread > 99 ? '99+' : String(unread);
    el.fabBadge.hidden = false;
  }

  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
  }

  /* ================= 文案渲染 ================= */

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function duration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  function setLive(isLive) {
    state.live = isLive;
    el.badge.classList.toggle('is-off', !isLive);
    el.badge.innerHTML = `<i></i>${isLive ? 'LIVE' : 'OFFLINE'}`;
    el.uptime.hidden = !isLive;
    if (!isLive) el.uptime2.textContent = '--:--';
  }

  function applyState(s) {
    if (typeof s.title === 'string' && s.title) {
      el.title.textContent = s.title;
      el.titleEcho.textContent = s.title;
    }
    if (s.streamer) {
      el.streamer.textContent = s.streamer;
      el.avatar.textContent = s.streamer.slice(0, 1);
    }
    if (typeof s.bio === 'string') el.bio.textContent = s.bio;
    if (typeof s.viewers === 'number') {
      el.viewers.textContent = s.viewers;
      el.viewers2.textContent = s.viewers;
    }
    if (s.startedAt) state.startedAt = s.startedAt;
    if (typeof s.hostOnline === 'boolean' && !s.hostOnline) state.hostId = null;
    if (s.muted) {
      const parts = [];
      if (s.muted.audio) parts.push('麦克风静音');
      if (s.muted.video) parts.push('摄像头关闭');
      el.mutedNote.hidden = parts.length === 0;
      el.mutedNote.textContent = parts.join(' · ');
    }
    if (typeof s.live === 'boolean') {
      const wasLive = state.live;
      setLive(s.live);
      if (s.live && !wasLive) waiting();
      if (!s.live && wasLive) offline('直播已结束', '主播结束了本场直播，页面会自动等待下一场。');
    }
  }

  function waiting() {
    el.idleTitle.textContent = '正在接入画面…';
    el.idleSub.textContent = '已建立与主播的点对点连接，稍等一下。';
    el.player.classList.remove('is-playing');
  }

  function offline(title, sub) {
    el.player.classList.remove('is-playing');
    el.idleTitle.textContent = title;
    el.idleSub.textContent = sub;
    el.video.srcObject = null;
    el.unmute.hidden = true;
    closePeer();
  }

  /* ================= 聊天 ================= */

  function chatIcon() {
    if (!el.chatEmpty) return;
    const has = el.chatList.querySelector('.msg');
    el.chatEmpty.style.display = has ? 'none' : '';
  }

  function scrollChat(force) {
    const list = el.chatList;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    if (force || nearBottom) list.scrollTop = list.scrollHeight;
  }

  function renderMessage(msg, forceScroll, quiet) {
    if (!msg || seen.has(msg.id)) return;
    seen.add(msg.id);

    if (msg.kind === 'system') {
      const line = document.createElement('div');
      line.className = 'msg-notice';
      line.textContent = msg.text;
      el.chatList.appendChild(line);
      scrollChat(forceScroll);
      return;
    }

    const row = document.createElement('div');
    row.className = 'msg';

    const dot = document.createElement('div');
    dot.className = 'msg-dot';
    dot.style.background = msg.color || '#a78bfa';
    dot.textContent = (msg.name || '?').slice(0, 1).toUpperCase();

    const body = document.createElement('div');
    body.className = 'msg-body';

    const name = document.createElement('div');
    name.className = 'msg-name';
    name.style.color = msg.color || '#a78bfa';
    name.textContent = msg.name || '访客';
    if (msg.role === 'host') {
      const tag = document.createElement('span');
      tag.className = 'msg-tag';
      tag.textContent = '主播';
      name.appendChild(tag);
    }

    const text = document.createElement('div');
    text.className = 'msg-text';
    text.textContent = msg.text;

    body.appendChild(name);
    body.appendChild(text);
    row.appendChild(dot);
    row.appendChild(body);
    el.chatList.appendChild(row);

    state.messages += 1;
    el.chatCount.textContent = state.messages;
    chatIcon();
    scrollChat(forceScroll);
    if (!quiet) bumpUnread();
  }

  function renderNotice(text) {
    renderMessage({ id: `n-${Date.now()}-${Math.random()}`, kind: 'system', text }, true);
  }

  el.chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text) return;
    el.chatInput.value = '';
    el.sendBtn.disabled = true;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nickname, text, role: 'viewer' })
      });
      if (res.status === 429) {
        toast('说得太快了，缓一下');
      } else if (!res.ok) {
        toast('发送失败，请重试');
      }
    } catch (err) {
      toast('网络异常，消息未发送');
    } finally {
      el.sendBtn.disabled = false;
      el.chatInput.focus();
    }
  });

  /* 昵称编辑 */
  function paintNameChip() {
    el.nameChip.textContent = nickname;
    el.nameChip.title = '点击修改昵称';
  }

  function makeNameChip() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'name-chip';
    btn.title = '点击修改昵称';
    btn.addEventListener('click', editName);
    return btn;
  }

  function editName() {
    const input = document.createElement('input');
    input.className = 'name-chip';
    input.value = nickname;
    input.maxLength = 20;
    el.nameChip.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) {
        const next = input.value.trim().slice(0, 20);
        if (next) {
          nickname = next;
          localStorage.setItem('luma:name', nickname);
        }
      }
      const btn = makeNameChip();
      btn.textContent = nickname;
      input.replaceWith(btn);
      el.nameChip = btn;
      el.chatInput.focus();
    };

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  el.nameChip.addEventListener('click', editName);

  /* ================= 移动端聊天面板 ================= */

  el.chatOpen.addEventListener('click', () => {
    el.chat.classList.add('is-open');
    el.chatOpen.style.display = 'none';
    unread = 0;
    el.fabBadge.hidden = true;
    scrollChat(true);
    setTimeout(() => el.chatInput.focus(), 320);
  });
  el.chatClose.addEventListener('click', () => {
    el.chat.classList.remove('is-open');
    el.chatOpen.style.display = '';
  });

  /* ================= 实时通话 ================= */

  let pc = null;
  let hostId = null;
  let pendingCandidates = [];
  let restartTimer = null;
  let unmuteOffered = false;

  function closePeer() {
    clearTimeout(restartTimer);
    pendingCandidates = [];
    if (pc) {
      try {
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.onconnectionstatechange = null;
        pc.close();
      } catch (err) { /* noop */ }
      pc = null;
    }
  }

  function postSignal(to, data) {
    if (!to) return;
    fetch('/api/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: clientId, to, data })
    }).catch(() => {});
  }

  function createPeer() {
    const peer = new RTCPeerConnection(ICE);

    peer.onicecandidate = (e) => {
      if (e.candidate && hostId) postSignal(hostId, { candidate: e.candidate });
    };

    peer.ontrack = (e) => {
      if (e.streams && e.streams[0]) {
        el.video.srcObject = e.streams[0];
      } else {
        const stream = el.video.srcObject instanceof MediaStream ? el.video.srcObject : new MediaStream();
        stream.addTrack(e.track);
        el.video.srcObject = stream;
      }
      el.video.play().catch(() => {});
    };

    peer.onconnectionstatechange = () => {
      const s = peer.connectionState;
      if (s === 'connected') {
        el.player.classList.add('is-playing');
        if (!unmuteOffered) {
          unmuteOffered = true;
          el.unmute.hidden = false;
        }
      } else if (s === 'disconnected') {
        toast('画面连接不稳定，正在恢复…');
      } else if (s === 'failed') {
        requestRestart();
      }
    };

    return peer;
  }

  function requestRestart() {
    if (!hostId) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (!state.live) return;
      postSignal(hostId, { request: 'restart' });
    }, 1200);
  }

  async function handleOffer(from, sdp) {
    hostId = from;
    state.hostId = from;
    closePeer();
    pc = createPeer();
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      while (pendingCandidates.length) {
        const c = pendingCandidates.shift();
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (err) { /* noop */ }
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      postSignal(from, { sdp: pc.localDescription });
      waiting();
    } catch (err) {
      requestRestart();
    }
  }

  el.video.addEventListener('playing', () => el.player.classList.add('is-playing'));

  el.unmute.addEventListener('click', () => {
    el.video.muted = false;
    el.video.volume = 1;
    el.video.play().catch(() => {});
    el.unmute.hidden = true;
  });

  /* ================= 事件流 ================= */

  let es = null;

  function connect() {
    es = new EventSource(
      `/api/events?role=viewer&id=${encodeURIComponent(clientId)}&name=${encodeURIComponent(nickname)}`
    );

    es.addEventListener('welcome', (e) => {
      const data = JSON.parse(e.data);
      applyState(data);
      el.chatList.querySelectorAll('.msg, .msg-notice').forEach((n) => n.remove());
      seen.clear();
      state.messages = 0;
      el.chatCount.textContent = '0';
      chatIcon();
    });

    es.addEventListener('history', (e) => {
      const list = JSON.parse(e.data);
      list.forEach((m) => renderMessage(m, false, true));
      scrollChat(true);
    });

    es.addEventListener('state', (e) => applyState(JSON.parse(e.data)));

    es.addEventListener('chat', (e) => renderMessage(JSON.parse(e.data), true));

    es.addEventListener('notice', (e) => {
      const data = JSON.parse(e.data);
      if (data.text) renderNotice(data.text);
    });

    es.addEventListener('go-live', () => {
      setLive(true);
      waiting();
    });

    es.addEventListener('stream-ended', () => {
      setLive(false);
      offline('直播已结束', '主播结束了本场直播，页面会自动等待下一场。');
    });

    es.addEventListener('signal', async (e) => {
      const { from, data } = JSON.parse(e.data) || {};
      if (!data) return;
      if (data.sdp && data.sdp.type === 'offer') {
        await handleOffer(from, data.sdp);
        return;
      }
      if (data.candidate) {
        if (pc && pc.remoteDescription) {
          try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (err) { /* noop */ }
        } else {
          pendingCandidates.push(data.candidate);
        }
      }
    });

    es.onerror = () => {
      // EventSource 会自动重连，这里只做提示
      if (es.readyState === EventSource.CLOSED) {
        toast('连接已断开，正在重试…');
        setTimeout(connect, 2500);
      }
    };
  }

  /* ================= 分享 ================= */

  if (el.shareBtn) el.shareBtn.addEventListener('click', async () => {
    const url = location.origin + '/' + location.search;
    try {
      await navigator.clipboard.writeText(url);
      toast('观看链接已复制');
    } catch (err) {
      toast(`复制失败，手动复制：${url}`);
    }
  });

  /* ================= 时钟 ================= */

  setInterval(() => {
    if (!state.live || !state.startedAt) return;
    const text = duration(Date.now() - state.startedAt);
    el.uptime.textContent = text;
    el.uptime2.textContent = text;
  }, 1000);

  /* ================= 启动 ================= */

  paintNameChip();
  chatIcon();
  connect();
})();
