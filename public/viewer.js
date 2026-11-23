(() => {
  'use strict';

  /* ================= 基础 ================= */

  const $ = (sel, root = document) => root.querySelector(sel);
  /* ICE 默认值：未收到服务端配置时使用，媒体固定走中继（relay）。
     服务端 welcome 里下发 iceServers 时会被覆盖，换机房只改环境变量。 */
  const ICE = {
    iceServers: [],
    iceTransportPolicy: 'relay',
    lines: [],
    line: ''
  };

  function applyIce(cfg) {
    if (!cfg) return;
    const list = Array.isArray(cfg) ? cfg : cfg.iceServers;
    if (!Array.isArray(list) || !list.length) return;
    ICE.iceServers = list;
    ICE.iceTransportPolicy = 'relay';
    ICE.lines = !Array.isArray(cfg) && Array.isArray(cfg.lines) ? cfg.lines : [];
    ICE.line = !Array.isArray(cfg) && cfg.line ? cfg.line : (ICE.lines[0] && ICE.lines[0].id) || '';
  }

  const el = {
    player: $('[data-player]'),
    video: $('[data-video]'),
    idle: $('[data-idle]'),
    idleTitle: $('[data-idle-title]'),
    idleSub: $('[data-idle-sub]'),
    badge: $('[data-live-badge]'),
    connection: $('[data-connection-type]'),
    title: $('[data-title]'),
    titleEcho: $('[data-title-echo]'),
    streamer: $('[data-streamer]'),
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
    fullscreen: $('[data-fullscreen]'),
    lineLabel: $('[data-line-label]'),
    audience: $('[data-audience]'),
    audienceList: $('[data-audience-list]'),
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
  /* 聊天名 = 登录账号，由服务端从 /api/me 认定，前端不提供自定义昵称。
     未启用登录的旧部署拿不到 user，退回一个占位名。 */
  let nickname = '用户';

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

  /* 圆形头像节点：有图片用 img（textContent 兜底），否则显示名字首字。 */
  function avatarNode(url, name, className) {
    const node = document.createElement('span');
    node.className = className;
    const initial = document.createElement('span');
    initial.textContent = (name || '?').slice(0, 1).toUpperCase();
    node.appendChild(initial);
    if (/^\/api\/avatar\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(url || '')) {
      const img = document.createElement('img');
      img.className = 'avatar-img';
      img.alt = '';
      img.src = url;
      img.addEventListener('error', () => { img.remove(); });
      node.appendChild(img);
    }
    return node;
  }

  /* 把已有容器（主播头像）更新为图片或首字，保留原元素不重建。 */
  function setAvatar(container, url, name) {
    if (!container) return;
    let initial = container.querySelector('.avatar-initial');
    if (!initial) {
      initial = document.createElement('span');
      initial.className = 'avatar-initial';
      container.replaceChildren(initial);
    }
    initial.textContent = (name || '?').slice(0, 1).toUpperCase();
    const valid = /^\/api\/avatar\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(url || '');
    let img = container.querySelector('.avatar-img');
    if (valid) {
      if (!img) {
        img = document.createElement('img');
        img.className = 'avatar-img';
        img.alt = '';
        img.addEventListener('error', () => { img.remove(); });
        container.appendChild(img);
      }
      if (img.getAttribute('src') !== url) img.src = url;
    } else if (img) {
      img.remove();
    }
  }

  /* 在场名单：服务端下发的账号名，主播标「主播」，其余为观众。
     用 DOM 文本而非 innerHTML，杜绝名字里的标签注入。 */
  function paintAudience(list) {
    if (!el.audience || !el.audienceList || !Array.isArray(list)) return;
    if (!list.length) { el.audience.hidden = true; return; }
    el.audience.hidden = false;
    const frag = document.createDocumentFragment();
    list.forEach((person, i) => {
      const name = String((person && person.name) || '').slice(0, 24);
      if (!name) return;
      if (i > 0) frag.appendChild(document.createTextNode('、'));
      const tag = document.createElement('span');
      tag.className = 'audience-name' + (person.role === 'host' ? ' is-host' : '');
      tag.appendChild(avatarNode(person.avatar, name, 'audience-avatar'));
      const label = document.createElement('span');
      label.textContent = person.role === 'host' ? `${name} · 主播` : name;
      tag.appendChild(label);
      frag.appendChild(tag);
    });
    el.audienceList.replaceChildren(frag);
  }

  function applyState(s) {
    if (typeof s.title === 'string' && s.title) {
      el.title.textContent = s.title;
      el.titleEcho.textContent = s.title;
    }
    if (s.streamer) {
      el.streamer.textContent = s.streamer;
      setAvatar(el.avatar, s.streamerAvatar, s.streamer);
    }
    /* 线路栏：显示服务端下发的当前中继节点名（数据驱动，未写死城市）。 */
    if (s.line && el.lineLabel) {
      const title = s.line.title || s.line.id || '';
      const label = title ? `TURN · ${title}` : '中继';
      if (el.lineLabel.textContent !== label) el.lineLabel.textContent = label;
      el.lineLabel.title = s.line.host ? `媒体经 ${title}（${s.line.host}）中继` : '媒体经中继服务器转发';
    }
    if (typeof s.viewers === 'number') {
      el.viewers.textContent = s.viewers;
      el.viewers2.textContent = s.viewers;
    }
    paintAudience(s.audience);
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
    if (typeof s.hostReconnecting === 'boolean') {
      if (s.hostReconnecting && !reconnectingNoted) {
        reconnectingNoted = true;
        toast('主播的网络抖了一下，正在自动重连…');
      } else if (!s.hostReconnecting) {
        reconnectingNoted = false;
      }
    }
  }

  function paintConnection(type, nodeLabel) {
    /* ICE 统计确认候选对之前不猜测直连/中继，避免刚 connected 的瞬间误报。 */
    if (type === 'unknown') type = 'connecting';
    const labels = {
      idle: ['未连接', '媒体尚未连接。'],
      connecting: ['连接中', '正在建立媒体连接。'],
      direct: ['直连', '媒体在双方之间直接传输（本站固定走 TURN 中继，正常情况下不会出现）。'],
      relay: ['TURN中继', '媒体经过 TURN 服务器中继，任一端使用中继即计为 TURN。'],
      reconnecting: ['断开重连中', '媒体连接已断开，正在恢复。']
    };
    let [text, title] = labels[type];
    if (type === 'relay' && nodeLabel) {
      text = `TURN中继·${nodeLabel}`;
      title = `媒体经过 TURN 中继（${nodeLabel}）。`;
    }
    if (el.connection.textContent !== text) el.connection.textContent = text;
    el.connection.title = title;
    el.connection.dataset.connectionType = type;
  }

  function waiting() {
    if (hardFail) return;
    el.idleTitle.textContent = '正在接入画面…';
    el.idleSub.textContent = '正在建立与主播的媒体连接，稍等一下。';
    if (!pc || pc.connectionState !== 'connected') paintConnection('connecting');
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

    const dot = avatarNode(msg.avatar, msg.name, 'msg-dot');
    dot.style.background = msg.color || '#e8462f';

    const body = document.createElement('div');
    body.className = 'msg-body';

    const name = document.createElement('div');
    name.className = 'msg-name';
    name.style.color = msg.color || '#e8462f';
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
        body: JSON.stringify({ name: nickname, text, role: 'viewer', clientId })
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

  /* 聊天名直接显示登录账号，只读，不可自定义 */
  function paintNameChip() {
    if (el.nameChip) el.nameChip.textContent = nickname;
  }

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
  let connectionAttemptTimer = null;
  let unmuteOffered = false;
  let everConnected = false;
  let failStreak = 0;
  let hardFail = false;
  let reconnectingNoted = false;
  let lastInbound = null;   // { bytes, received, lost, at }
  let stalledCount = 0;

  function closePeer() {
    paintConnection('idle');
    clearTimeout(restartTimer);
    clearTimeout(connectionAttemptTimer);
    pendingCandidates = [];
    lastInbound = null;
    stalledCount = 0;
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

  /* 连不上时说人话，别让人盯着「正在接入画面…」等到放弃 */
  function showConnectProblem() {
    el.player.classList.remove('is-playing');
    el.idleTitle.textContent = '连不上主播的画面';
    el.idleSub.textContent =
      '媒体连接没有建立起来。画面全部经本站 TURN 服务器中转，通常是中继线路暂时不可用或主播刚好重连。稍等十几秒刷新本页一般就能恢复；一直不行就找主播确认开播状态。';
  }

  async function probeIce(peer) {
    try {
      const stats = await peer.getStats();
      let ok = false;
      stats.forEach((r) => {
        if (r.type !== 'candidate-pair') return;
        if (r.state === 'succeeded' || (typeof r.bytesReceived === 'number' && r.bytesReceived > 0)) ok = true;
      });
      return ok;
    } catch (err) {
      return null;
    }
  }

  async function onPeerFailed(peer) {
    failStreak += 1;
    const reachable = await probeIce(peer).catch(() => null);

    /* 只有一条中继线路，失败也不自动重试：反复重建会让主播端
       peer 抖动，画面看上去就像在两条线路之间来回跳。 */
    hardFail = true;
    clearTimeout(restartTimer);
    paintConnection('idle');
    showConnectProblem();
  }

  function createPeer() {
    const peer = new RTCPeerConnection({
      iceServers: ICE.iceServers,
      iceTransportPolicy: ICE.iceTransportPolicy
    });

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
      if (pc !== peer) return;
      const s = peer.connectionState;
      clearTimeout(connectionAttemptTimer);
      paintConnection(s === 'connected' ? 'unknown'
        : ['disconnected', 'failed'].includes(s) ? 'reconnecting'
        : s === 'closed' ? 'idle' : 'connecting');
      if (s === 'connected') {
        sampleLink();
        everConnected = true;
        failStreak = 0;
        hardFail = false;
        el.player.classList.add('is-playing');
        if (!unmuteOffered) {
          unmuteOffered = true;
          el.unmute.hidden = false;
        }
      } else if (s === 'disconnected') {
        toast('画面连接不稳定，正在恢复…');
      } else if (s === 'failed') {
        onPeerFailed(peer);
      }
    };

    return peer;
  }

  function requestRestart(delay) {
    if (!hostId) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (!state.live) return;
      postSignal(hostId, { request: 'restart' });
    }, delay || 1200);
  }

  async function handleOffer(from, sdp) {
    hostId = from;
    state.hostId = from;
    closePeer();
    pc = createPeer();
    connectionAttemptTimer = setTimeout(() => {
      if (pc && pc.connectionState !== 'connected') {
        paintConnection('idle');
      }
    }, 10000);
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
      hardFail = true;
      clearTimeout(restartTimer);
      paintConnection('idle');
      showConnectProblem();
    }
  }

  el.video.addEventListener('playing', () => el.player.classList.add('is-playing'));

  el.unmute.addEventListener('click', () => {
    el.video.muted = false;
    el.video.volume = 1;
    el.video.play().catch(() => {});
    el.unmute.hidden = true;
  });

  /* 固定中继 TURN，不再提供线路选择或切换入口。 */
  let turnLine = '';

  function syncTurnLine(ice) {
    if (ice && ice.line) turnLine = ice.line;
    ICE.line = turnLine;
    ICE.iceTransportPolicy = 'relay';
  }

  function reconnectIce() {
    esGen += 1;
    try {
      if (es) {
        es.onerror = null;
        es.close();
      }
    } catch (err) { /* noop */ }
    es = null;
    closePeer();
    hardFail = false;
    failStreak = 0;
    connect();
  }

  /* ================= 事件流 ================= */

  let es = null;
  /* 每次主动重建 SSE 都递增：旧连接迟到的 welcome/onerror 不能再覆盖新线路 */
  let esGen = 0;

  function connect() {
    const myGen = esGen;
    es = new EventSource(
      `/api/events?role=viewer&id=${encodeURIComponent(clientId)}&name=${encodeURIComponent(nickname)}`
    );

    es.addEventListener('welcome', (e) => {
      if (myGen !== esGen) return;  /* 旧连接的迟到首包，别把新线路改回去 */
      const data = JSON.parse(e.data);
      applyIce(data.ice);
      syncTurnLine(data.ice);
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

    /* 服务端优雅退出时先发这条，避免用户把「服务器重启」当成网络卡死 */
    es.addEventListener('server-shutdown', () => {
      setLive(false);
      offline('服务器正在重启', '稍等十几秒刷新本页就能继续观看。');
      try { es.close(); } catch (err) { /* noop */ }
    });

    /* 同一账号在别处观看/开播：本页立刻停看、断流，且不再自动重连，
       否则两个页面会反复互踢。 */
    es.addEventListener('account-taken', () => {
      hardFail = true;
      try { es.close(); } catch (err) { /* noop */ }
      setLive(false);
      offline('账号已在别处使用', '这个账号正在别处观看或开播，本页面已停止播放。刷新页面可重新接管。');
      toast('账号已在别处使用，本页面已停止');
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
      if (myGen !== esGen) return;  /* 已被主动重建，旧 SSE 不得影响新线路 */
      /* 不让 EventSource 自动重连：重连可能带着旧的 turn 参数回来，
         把连接拉回已经不存在的线路。 */
      try { es.close(); } catch (err) { /* noop */ }
      clearTimeout(restartTimer);
      hardFail = true;
      paintConnection('idle');
      toast('当前线路连接已断开，请手动选择线路');
    };
  }

  /* ================= 链路质量回报 + 自检 ================= */
  /* 每 3 秒做两件事：
     1) 把丢包/RTT 回报给主播，主播按档位单独调这一路的码率；
     2) 自检「连接状态是 connected，但画面一个字节都不进」的半死连接。 */

  let sampling = false;

  function selectedLink(stats) {
    const byId = new Map();
    stats.forEach((r) => byId.set(r.id, r));
    const rows = [...byId.values()];
    const transports = rows.filter((r) => r.type === 'transport' && r.selectedCandidatePairId);
    let pair = null;
    if (transports.length) {
      // 标准引用存在但统计缺失时，不退回可能过期的 nominated 候选对。
      const ids = new Set(transports.map((r) => r.selectedCandidatePairId));
      if (ids.size === 1) pair = byId.get(transports[0].selectedCandidatePairId);
    } else {
      const selected = rows.filter((r) => r.type === 'candidate-pair' && r.selected === true);
      const nominated = rows.filter((r) => r.type === 'candidate-pair' && r.nominated === true && r.state === 'succeeded');
      if (selected.length === 1) pair = selected[0];
      else if (!selected.length && nominated.length === 1) pair = nominated[0];
    }
    if (!pair || pair.type !== 'candidate-pair' || (pair.state && pair.state !== 'succeeded')) {
      return { connectionType: 'unknown', rtt: 0, relayAddr: '' };
    }
    const local = byId.get(pair.localCandidateId);
    const remote = byId.get(pair.remoteCandidateId);
    const types = [local && local.candidateType, remote && remote.candidateType];
    let connectionType = 'unknown';
    if (types.includes('relay')) connectionType = 'relay';
    else if (types.every((type) => ['host', 'srflx', 'prflx'].includes(type))) connectionType = 'direct';
    /* 选了 TURN 线路但 stats 读不到候选类型（部分浏览器 remotecandidate 不暴露）：
       既然是强制中继配置，按中继算，不要误报成直连。 */
    if (connectionType === 'unknown' && ICE.iceTransportPolicy === 'relay') connectionType = 'relay';
    /* 中继候选的 address 就是 TURN 给的那段地址，等于节点本身的公网 IP；
       带回去让主播端能标出「这一路走的是哪条中继」 */
    const relaySide = [local, remote].find((c) => c && c.candidateType === 'relay');
    return {
      connectionType,
      rtt: typeof pair.currentRoundTripTime === 'number' ? pair.currentRoundTripTime : 0,
      relayAddr: relaySide ? String(relaySide.address || relaySide.ip || '') : ''
    };
  }

  /* 把中继 IP 换成人看得懂的名字，取不到就退回 IP */
  function relayLabel(addr) {
    const hit = addr ? (ICE.lines || []).find((l) => l && l.host === addr) : null;
    if (hit) return hit.title || hit.id;
    /* stats 里的地址可能是 coturn 分的内网 relay IP，匹配不到就退回当前线路名 */
    const cur = (ICE.lines || []).find((l) => l && l.id === ICE.line && l.id !== 'p2p');
    return cur ? (cur.title || cur.id) : (addr || '');
  }

  async function sampleLink() {
    if (sampling || !state.live || !pc || !hostId) return;
    if (pc.connectionState !== 'connected') return;

    sampling = true;
    const sampledPeer = pc;
    let bytes = 0;
    let received = 0;
    let lost = 0;
    let rtt = 0;
    let connectionType = 'unknown';
    let relayAddr = '';

    try {
      const stats = await sampledPeer.getStats();
      ({ connectionType, rtt, relayAddr } = selectedLink(stats));

      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video' && typeof r.bytesReceived === 'number') {
          bytes = r.bytesReceived;
          received = r.packetsReceived || 0;
          lost = r.packetsLost || 0;
        }
      });
    } catch (err) {
      // 无统计也要清除旧路径并回报 unknown，避免继续展示旧的直连/中继。
    }

    // 采样期间可能已重建连接，旧结果不能污染新连接的计数和档位。
    if (pc !== sampledPeer || sampledPeer.connectionState !== 'connected' || !state.live) { sampling = false; return; }
    paintConnection(connectionType, connectionType === 'relay' ? relayLabel(relayAddr) : '');
    const now = performance.now();
    let kbps = 0;
    let loss = 0;

    if (lastInbound && now > lastInbound.at) {
      const dt = (now - lastInbound.at) / 1000;
      kbps = Math.max(0, Math.round(((bytes - lastInbound.bytes) * 8) / dt / 1000));

      const dRecv = Math.max(0, received - lastInbound.received);
      const dLost = Math.max(0, lost - lastInbound.lost);
      loss = dRecv + dLost > 0 ? dLost / (dRecv + dLost) : 0;

      if (bytes === lastInbound.bytes && !(state.muted && state.muted.video)) {
        stalledCount += 1;
        if (stalledCount >= 3) {
          stalledCount = 0;
          toast('当前线路画面无数据，请手动切换线路');
          hardFail = true;
          paintConnection('idle');
        }
      } else {
        stalledCount = 0;
      }
    }

    lastInbound = { bytes, received, lost, at: now };
    sampling = false;

    postSignal(hostId, {
      stats: {
        kbps,
        loss: Number(loss.toFixed(3)),
        rtt: Math.round(rtt * 1000),
        /* relay=true 表示这一路在走 TURN 中继，主播端会据此压低码率省服务器带宽 */
        relay: connectionType === 'relay',
        connectionType,
        /* 走中继时带上节点地址，主播端据此显示节点名 */
        relayAddr: connectionType === 'relay' ? relayAddr : ''
      }
    });
  }

  setInterval(sampleLink, 3000);

  /* ================= 分享 ================= */

  function paintFullscreen() {
    if (!el.fullscreen) return;
    const active = document.fullscreenElement === el.player;
    el.fullscreen.classList.toggle('is-active', active);
    el.fullscreen.setAttribute('aria-label', active ? '退出全屏' : '全屏播放');
    el.fullscreen.title = active ? '退出全屏' : '全屏播放';
  }

  if (el.fullscreen) el.fullscreen.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement === el.player) await document.exitFullscreen();
      else if (el.player.requestFullscreen) await el.player.requestFullscreen();
      else if (el.video.webkitEnterFullscreen) el.video.webkitEnterFullscreen();
    } catch (err) {
      /* 浏览器拒绝全屏时保持普通播放，不影响直播 */
    }
    paintFullscreen();
  });
  document.addEventListener('fullscreenchange', paintFullscreen);

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

  /* 先从登录态拿账号名（服务端也会用 cookie 覆盖，这里只为了前端显示一致），
     无论成功与否最终都会连上直播间，不因账号接口异常而卡住观看。 */
  fetch('/api/me', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((me) => {
      if (me && me.user) nickname = String(me.user).slice(0, 24);
    })
    .catch(() => { /* 未启用登录或网络抖动：沿用占位名 */ })
    .finally(() => {
      paintNameChip();
      connect();
    });
})();
