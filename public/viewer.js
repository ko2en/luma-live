(() => {
  'use strict';

  /* ================= 基础 ================= */

  const $ = (sel, root = document) => root.querySelector(sel);
  /* ICE 默认值（纯 STUN 直连）。服务端 welcome 里下发 iceServers 时会被覆盖，
     所以配了 TURN 的部署不用改前端；没配的部署行为与以前完全一致。 */
  const ICE = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ],
    iceTransportPolicy: 'all',  /* welcome 收到前先用默认；收到后由服务端决定 */
    lines: [],   /* 服务端下发的可选线路，用来填下拉 */
    line: 'p2p'  /* 本次实际生效的线路 */
  };

  function applyIce(cfg) {
    if (!cfg) return;
    const list = Array.isArray(cfg) ? cfg : cfg.iceServers;
    if (!Array.isArray(list) || !list.length) return;
    ICE.iceServers = list;
    /* 选了 TURN 线路就只收集 relay 候选，浏览器不会再偷偷走直连；
       这样「选上海」才真的走上海中继，状态标签也不会显示成 P2P。 */
    ICE.iceTransportPolicy = !Array.isArray(cfg) && cfg.iceTransportPolicy === 'relay' ? 'relay' : 'all';
    /* line / lines 服务端下发：本次生效的线路 + 全部可选线路 */
    ICE.line = !Array.isArray(cfg) && typeof cfg.line === 'string' && cfg.line ? cfg.line : 'p2p';
    ICE.lines = !Array.isArray(cfg) && Array.isArray(cfg.lines) ? cfg.lines : [];
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
    turnPick: $('[data-turn-pick]'),
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
    /* 连上了却没有 relay 候选，就是直连 —— 不再显示「检测中」这种中间态 */
    if (type === 'unknown') type = 'direct';
    const labels = {
      idle: ['未连接', '媒体尚未连接。'],
      connecting: ['连接中', '正在建立媒体连接。'],
      direct: ['P2P直连', '媒体在双方之间直接传输，不经过 TURN 中继。'],
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
  let everConnected = false;
  let failStreak = 0;
  let hardFail = false;
  let reconnectingNoted = false;
  let lastInbound = null;   // { bytes, received, lost, at }
  let stalledCount = 0;

  function closePeer() {
    paintConnection('idle');
    clearTimeout(restartTimer);
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

  /* 打洞失败时说人话，别让人盯着「正在接入画面…」等到放弃 */
  function showConnectProblem() {
    el.player.classList.remove('is-playing');
    el.idleTitle.textContent = '连不上主播的画面';
    el.idleSub.textContent =
      '你和主播之间没能建立直连。公司网络、校园网、部分手机热点会在中间做地址转换，导致 P2P 打洞失败。换一个网络（比如手机热点）重新打开本页通常就好了；如果一直不行，需要主播那边部署 TURN 中继。';
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

    // 还有可用候选对，或者之前成功过（只是抖动）→ 快速重试
    if (reachable === true || everConnected || failStreak < 2) {
      requestRestart();
      return;
    }

    hardFail = true;
    showConnectProblem();
    requestRestart(20000); // 慢速兜底：换了网络还能自愈
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

  /* ================= 中继线路 ================= */

  /* 服务端下发可选线路（P2P / 各 TURN 入口），这里只负责选哪一条：
     选择记在本机 localStorage，重连时以 turn=<线路 id> 告诉服务端。
     选 P2P 就不给任何 TURN，打洞不通就一直停在那儿，由人自己换线。 */
  const TURN_KEY = 'luma.turn';
  let turnLine = readTurnPref();

  function readTurnPref() {
    try {
      return localStorage.getItem(TURN_KEY) || '';
    } catch (err) {
      return '';
    }
  }

  function writeTurnPref(v) {
    try {
      if (!v || v === 'p2p') localStorage.removeItem(TURN_KEY);
      else localStorage.setItem(TURN_KEY, v);
    } catch (err) { /* 隐私模式写不进去，当次有效即可 */ }
  }

  function paintTurnPick() {
    if (!el.turnPick) return;
    const lines = ICE.lines || [];
    /* 只有 P2P 一条（没配 TURN 的部署）就不显示 */
    if (lines.length < 2) {
      el.turnPick.hidden = true;
      return;
    }
    el.turnPick.hidden = false;

    const sig = lines.map((l) => `${l.id}:${l.title}`).join(',');
    if (el.turnPick.dataset.built !== sig) {
      el.turnPick.textContent = '';
      lines.forEach((l) => {
        const opt = document.createElement('option');
        opt.value = l.id;
        opt.textContent = l.title || l.id;
        el.turnPick.appendChild(opt);
      });
      el.turnPick.dataset.built = sig;
    }

    const want = ICE.line || 'p2p';
    if (el.turnPick.value !== want) el.turnPick.value = want;
    el.turnPick.dataset.line = want;
    el.turnPick.title = `当前线路：${(lines.find((l) => l.id === want) || {}).title || want}`;
  }

  /* 服务端实际生效的线路若与本地记录不同（线路被删/改名），以服务端为准 */
  function syncTurnLine(ice) {
    if (!ice) return;
    const actual = ice.line || 'p2p';
    turnLine = actual;
    if (readTurnPref() && readTurnPref() !== actual) writeTurnPref(actual);
  }

  function switchLine(id) {
    turnLine = id;
    writeTurnPref(id);
    /* 立刻把下拉切到新值，别等服务端 welcome 回来（那要一两秒，看起来像没生效） */
    ICE.line = id;
    ICE.iceTransportPolicy = id === 'p2p' ? 'all' : 'relay';
    paintTurnPick();
    /* 换线路必须重建：ICE 配置只在新建 RTCPeerConnection 时生效 */
    reconnectIce();
  }

  function reconnectIce() {
    try { if (es) es.close(); } catch (err) { /* noop */ }
    es = null;
    closePeer();
    hardFail = false;
    failStreak = 0;
    connect();
  }

  if (el.turnPick) {
    el.turnPick.addEventListener('change', () => switchLine(el.turnPick.value));
  }

  /* ================= 事件流 ================= */

  let es = null;

  function connect() {
    const turnQ = turnLine ? `&turn=${encodeURIComponent(turnLine)}` : '';
    es = new EventSource(
      `/api/events?role=viewer&id=${encodeURIComponent(clientId)}&name=${encodeURIComponent(nickname)}${turnQ}`
    );

    es.addEventListener('welcome', (e) => {
      const data = JSON.parse(e.data);
      applyIce(data.ice);
      syncTurnLine(data.ice);
      paintTurnPick();
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
       既然是强制中继配置，按中继算，不要误报成 P2P。 */
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
          toast('画面卡住了，正在重新连接…');
          requestRestart(500);
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
        /* 走中继时带上节点地址，主播端据此显示「上海 / 香港」 */
        relayAddr: connectionType === 'relay' ? relayAddr : ''
      }
    });
  }

  setInterval(sampleLink, 3000);

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
