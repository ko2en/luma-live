(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);

  /* ICE 默认值（纯 STUN 直连）。服务端 welcome 里下发 iceServers 时会被覆盖，
     配了 TURN 的部署不需要改前端；没配的部署行为与以前完全一致。 */
  const ICE = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ],
    iceTransportPolicy: 'all',  /* welcome 收到前先用默认；收到后由服务端决定 */
    lines: [],   /* 服务端下发的可选线路，用来填下拉 */
    line: 'p2p',  /* 本次实际生效的线路 */
    byLine: {}    /* 每条线路的现签 ICE 配置：主播按观众的选择逐路取用 */
  };

  function applyIce(cfg) {
    if (!cfg) return;
    const list = Array.isArray(cfg) ? cfg : cfg.iceServers;
    if (!Array.isArray(list) || !list.length) return;
    ICE.iceServers = list;
    ICE.iceTransportPolicy = !Array.isArray(cfg) && cfg.iceTransportPolicy === 'relay' ? 'relay' : 'all';
    /* line / lines 服务端下发：本次生效的线路 + 全部可选线路（主播端只用来标注节点名） */
    ICE.line = !Array.isArray(cfg) && typeof cfg.line === 'string' && cfg.line ? cfg.line : 'p2p';
    ICE.lines = !Array.isArray(cfg) && Array.isArray(cfg.lines) ? cfg.lines : [];
    if (!Array.isArray(cfg) && cfg.byLine && typeof cfg.byLine === 'object') ICE.byLine = cfg.byLine;
  }

  /* 中继 IP → 节点显示名 */
  function relayLabel(addr) {
    if (!addr) return '';
    const hit = (ICE.lines || []).find((l) => l && l.host === addr);
    return hit ? (hit.title || hit.id) : addr;
  }

  const el = {
    preview: $('[data-preview]'),
    wrap: $('[data-preview-wrap]'),
    empty: $('[data-preview-empty]'),
    emptyTitle: $('[data-empty-title]'),
    emptySub: $('[data-empty-sub]'),
    openTab: $('[data-open-tab]'),
    retryCam: $('[data-retry-cam]'),
    btnCam: $('[data-btn-cam]'),
    dotCam: $('[data-dot-cam]'),
    btnMic: $('[data-btn-mic]'),
    dotMic: $('[data-dot-mic]'),
    micSelect: $('[data-mic-select]'),
    vuState: $('[data-vu-state]'),
    mediaNote: $('[data-media-note]'),
    stAudio: $('[data-st-audio]'),
    btnShare: $('[data-btn-share]'),
    rec: $('[data-rec]'),
    title: $('[data-title-input]'),
    goLive: $('[data-go-live]'),
    hint: $('[data-hint]'),
    badge: $('[data-live-badge]'),
    viewers: $('[data-viewers]'),
    stStatus: $('[data-st-status]'),
    stViewers: $('[data-st-viewers]'),
    stTime: $('[data-st-time]'),
    stRes: $('[data-st-res]'),
    stSend: $('[data-st-send]'),
    stBitrate: $('[data-st-bitrate]'),
    stConnections: $('[data-st-connections]'),
    share: $('[data-share-url]'),
    copy: $('[data-copy]'),
    keyRow: $('[data-key-row]'),
    keyInput: $('[data-key-input]'),
    keyState: $('[data-key-state]'),
    taken: $('[data-taken-over]'),
    takeOverBtn: $('[data-take-over]'),
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
      : `h-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  const hostId = uuid();
  const peers = new Map();
  const viewerLines = new Map();  /* viewerId → 该观众当前选的线路（主播逐路跟随） */
  let localStream = null;
  let camStream = null;
  let screenStream = null;
  let usingScreen = false;
  let camOn = false;
  let micOn = false;
  let live = false;
  let startedAt = null;
  let toastTimer = null;
  let lastBytes = null;
  let lastStatAt = 0;

  /* 开播口令：只存本机，永远不放进分享链接（否则观众都能开播） */
  let streamKey = (localStorage.getItem('luma:key') || '').trim();
  let keyRequired = false;
  let es = null;
  /* 被别处的开播台顶替了：页面要停手，且不许自动重连回来再顶回去，
     否则两个标签页会每 2~3 秒互相踢一次，观众永远拿不到稳定的 offer。 */
  let evicted = false;

  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  function postStream(body) {
    return post('/api/stream', { id: hostId, key: streamKey, ...body });
  }

  function setKeyState(text, kind) {
    if (!el.keyState) return;
    el.keyState.textContent = text || '';
    if (kind) el.keyState.dataset.state = kind;
    else delete el.keyState.dataset.state;
  }

  /* ================= 媒体 ================= */
  /* 视频和音频分开申请：任一失败都不影响另一个。
     音频走 WebAudio 混音总线（麦克风 + 屏幕系统声音），
     混出一条 program 音轨推给观众。 */

  const AudioCtxCtor = window.AudioContext || window.webkitAudioContext;

  let audioCtx = null;
  let programDest = null;
  let programTrack = null;
  let masterGain = null;
  let micGain = null;
  let screenGain = null;
  let micSource = null;
  let screenSource = null;
  let analyser = null;
  let meterRAF = 0;
  let micStream = null;
  let micIssue = null;      // denied | nodevice | busy | timeout | insecure | constraint | unknown
  let screenAudioOn = false;
  let micDevices = [];
  let preferredMicId = '';

  function escapeHtml(v) {
    return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function withTimeout(promise, ms, tag) {
    let timer = null;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(tag || 'timeout');
        err.name = 'TimeoutError';
        reject(err);
      }, ms);
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
  }

  function classifyMediaError(err) {
    const name = err && err.name;
    if (name === 'TimeoutError') return 'timeout';
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'nodevice';
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') return 'constraint';
    if (window.isSecureContext === false) return 'insecure';
    return 'unknown';
  }

  const MIC_ISSUES = {
    denied: {
      title: '麦克风被拒绝了',
      text: '点地址栏左侧的图标 → 麦克风 → 允许；Windows 还要在「设置 › 隐私和安全性 › 麦克风」里打开「允许桌面应用访问麦克风」。改完点「重试授权」。'
    },
    nodevice: {
      title: '没检测到麦克风',
      text: '插上麦克风或耳机后点「重试授权」。也可以只用「共享屏幕」做无声直播。'
    },
    busy: {
      title: '麦克风被占用了',
      text: '会议、录屏、语音软件会独占麦克风。关掉它们再点「重试授权」。'
    },
    timeout: {
      title: '等待授权超时',
      text: '浏览器一直在等你的确认。看看地址栏附近有没有权限气泡，允许后点「重试授权」。'
    },
    insecure: {
      title: '当前环境不允许用麦克风',
      text: '必须通过 https 链接或 localhost 打开，否则浏览器会直接拒绝采集。'
    },
    constraint: {
      title: '这个麦克风用不了',
      text: '在「麦克风来源」里换一个设备再试。'
    },
    unknown: {
      title: '麦克风启动失败',
      text: '点「重试授权」再来一次，或者换一个麦克风设备。'
    }
  };

  function micIssueTitle(kind) {
    const item = MIC_ISSUES[kind] || MIC_ISSUES.unknown;
    return item.title;
  }

  /* 提示条：标题 + 说明，短句在前，细节在后 */
  function setMediaNote(note) {
    if (!el.mediaNote) return;
    if (!note) {
      el.mediaNote.hidden = true;
      el.mediaNote.innerHTML = '';
      return;
    }
    el.mediaNote.hidden = false;
    el.mediaNote.dataset.kind = note.kind;
    el.mediaNote.innerHTML =
      `<b>${escapeHtml(note.title)}</b><span>${escapeHtml(note.text)}</span>`;
  }

  function currentVideoTrack() {
    const primary = usingScreen ? screenStream : camStream;
    const fromPrimary = primary && primary.getVideoTracks()[0];
    if (fromPrimary) return fromPrimary;
    return (camStream && camStream.getVideoTracks()[0]) || null;
  }

  const hasVideo = () => !!currentVideoTrack();
  const hasAudio = () => !!micStream || screenAudioOn;

  function paintMediaState() {
    const micOk = micOn && !!micStream;
    el.dotCam.style.background = camOn ? 'var(--ok)' : '#6b6a7d';
    el.dotMic.style.background = micOk ? 'var(--ok)' : (micIssue ? '#ff5b63' : '#6b6a7d');
    el.btnCam.classList.toggle('is-off', !camOn);
    el.btnMic.classList.toggle('is-off', !micOk);
    el.wrap.classList.toggle('is-mirrored', !usingScreen);

    el.empty.style.display = hasVideo() ? 'none' : '';

    el.stRes.textContent = resolutionText();
    paintAudioState();
  }

  function paintAudioState() {
    if (el.stAudio) {
      const parts = [];
      if (micOn && micStream) parts.push('麦克风');
      if (screenAudioOn) parts.push('系统声音');
      el.stAudio.textContent = parts.length ? parts.join(' + ') : '无';
      el.stAudio.className = `v ${parts.length ? 'ok' : ''}`;
    }

    setMediaNote(audioNote());
  }

  function audioNote() {
    if (micIssue) {
      const item = MIC_ISSUES[micIssue] || MIC_ISSUES.unknown;
      return { kind: 'bad', title: item.title, text: item.text };
    }
    if (usingScreen && !screenAudioOn) {
      return {
        kind: 'warn',
        title: '这次共享没有带到系统声音',
        text: '要共享电脑里播放的音乐/视频：在共享弹窗里选「标签页」，并勾选「分享标签页音频」。共享「整个屏幕」在 Windows 的 Chrome/Edge 上拿不到系统声音，需要装虚拟声卡（如 VB-Cable）；macOS 需要 BlackHole。'
      };
    }
    if (!hasVideo() && micStream) {
      return {
        kind: 'warn',
        title: '只有声音、没有画面',
        text: '摄像头没拿到权限，可以先做纯语音直播；想上镜就点「重试授权」。'
      };
    }
    if (usingScreen && screenAudioOn && !micStream) {
      return {
        kind: 'info',
        title: '只共享了系统声音',
        text: '观众听得到电脑里的声音，但听不到你说话。想解说就点「麦克风」授权。'
      };
    }
    return null;
  }

  function resolutionText() {
    const track = currentVideoTrack();
    if (!track) return '无画面';
    const s = track.getSettings ? track.getSettings() : {};
    if (s.width && s.height) return `${s.width}×${s.height} · ${usingScreen ? '屏幕' : '摄像头'}`;
    return usingScreen ? '屏幕共享' : '摄像头';
  }

  /* ---------- 音频总线 ---------- */

  function ensureAudioGraph() {
    if (audioCtx) return true;
    if (!AudioCtxCtor) return false;
    try {
      audioCtx = new AudioCtxCtor();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 1;

      micGain = audioCtx.createGain();
      micGain.gain.value = 0;
      screenGain = audioCtx.createGain();
      screenGain.gain.value = 1;

      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.72;

      programDest = audioCtx.createMediaStreamDestination();

      micGain.connect(masterGain);
      screenGain.connect(masterGain);
      masterGain.connect(analyser);
      masterGain.connect(programDest);

      programTrack = programDest.stream.getAudioTracks()[0] || null;
      startMeter();
      return true;
    } catch (err) {
      audioCtx = null;
      programTrack = null;
      return false;
    }
  }

  function resumeAudio() {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }

  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => {
    window.addEventListener(ev, resumeAudio, { passive: true });
  });

  function attachMic(stream) {
    if (!ensureAudioGraph()) return;
    if (micSource) {
      try { micSource.disconnect(); } catch (err) { /* noop */ }
      micSource = null;
    }
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    try {
      micSource = audioCtx.createMediaStreamSource(new MediaStream([track]));
      micSource.connect(micGain);
      micGain.gain.value = micOn ? 1 : 0;
    } catch (err) {
      micSource = null;
    }
  }

  function attachScreenAudio(stream) {
    const track = stream && stream.getAudioTracks()[0];
    if (screenSource) {
      try { screenSource.disconnect(); } catch (err) { /* noop */ }
      screenSource = null;
    }
    screenAudioOn = false;
    if (!track) return;
    if (!ensureAudioGraph()) return;
    try {
      screenSource = audioCtx.createMediaStreamSource(new MediaStream([track]));
      screenSource.connect(screenGain);
      screenGain.gain.value = 1;
      screenAudioOn = true;
      track.addEventListener('ended', () => {
        screenAudioOn = false;
        paintMediaState();
        syncMuted();
      });
      resumeAudio();
    } catch (err) {
      screenSource = null;
      screenAudioOn = false;
    }
  }

  function startMeter() {
    if (!analyser || meterRAF) return;
    const buf = new Uint8Array(analyser.fftSize);
    const segs = Array.from(document.querySelectorAll('[data-vu] i'));
    let quiet = 0;

    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      const level = Math.max(0, Math.min(1, rms * 4.5));
      const lit = Math.round(level * segs.length);
      for (let i = 0; i < segs.length; i += 1) segs[i].classList.toggle('on', i < lit);

      if (el.vuState) {
        if (level > 0.02) {
          quiet = 0;
          el.vuState.textContent = '有声音';
          el.vuState.dataset.state = 'ok';
        } else {
          quiet += 1;
          if (quiet > 45) {
            const on = hasAudio() && (micOn || screenAudioOn);
            el.vuState.textContent = on ? '没有收到声音' : '无输入';
            el.vuState.dataset.state = on ? 'warn' : '';
          }
        }
      }
      meterRAF = requestAnimationFrame(tick);
    };
    tick();
  }

  /* ---------- 设备 ---------- */

  async function refreshMicList() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      micDevices = all.filter((d) => d.kind === 'audioinput');

      if (el.micSelect) {
        if (!micDevices.length) {
          el.micSelect.innerHTML = '<option value="">没有检测到麦克风</option>';
        } else {
          const activeTrack = micStream && micStream.getAudioTracks()[0];
          const settings = activeTrack && activeTrack.getSettings ? activeTrack.getSettings() : {};
          const active = preferredMicId || settings.deviceId || el.micSelect.value;

          el.micSelect.innerHTML = micDevices
            .map((d, i) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || `麦克风 ${i + 1}`)}</option>`)
            .join('');

          const valid = micDevices.some((d) => d.deviceId === active);
          if (valid && active) el.micSelect.value = active;
          else if (micDevices[0]) el.micSelect.value = micDevices[0].deviceId;
        }
      }
    } catch (err) { /* noop */ }
  }

  /* ---------- 采集 ---------- */

  function showMediaIssue(kind) {
    const inFrame = window.self !== window.top;

    if (kind === 'iframe' || (inFrame && kind !== 'ok')) {
      el.emptyTitle.textContent = '预览框里拿不到摄像头和麦克风';
      el.emptySub.textContent =
        '浏览器不允许被嵌入的页面访问摄像头、麦克风和屏幕。点下面的按钮，在独立标签页里打开控制台即可正常开播。';
      if (el.openTab) el.openTab.hidden = false;
      if (el.retryCam) el.retryCam.hidden = true;
      return;
    }

    if (el.openTab) el.openTab.hidden = true;
    if (el.retryCam) el.retryCam.hidden = false;

    if (kind === 'denied') {
      el.emptyTitle.textContent = '还没有拿到摄像头权限';
      el.emptySub.textContent =
        '点下面的「重试授权」，在浏览器弹窗里选「允许」。如果之前点过拒绝，需要点地址栏左侧的图标把它改回允许。';
    } else if (kind === 'nodevice') {
      el.emptyTitle.textContent = '没有检测到摄像头';
      el.emptySub.textContent = '设备没接摄像头，或者被其他程序（会议软件等）占用了。可以改用「共享屏幕」开播。';
    } else if (kind === 'busy') {
      el.emptyTitle.textContent = '摄像头被占用';
      el.emptySub.textContent = '有别的程序正在用摄像头（会议、录屏、其他浏览器标签）。关掉它再点「重试授权」。';
    } else if (kind === 'insecure') {
      el.emptyTitle.textContent = '当前环境不允许调用摄像头';
      el.emptySub.textContent = '浏览器要求 HTTPS 或 localhost 才能开播。请通过分享链接（https）访问，或改用「共享屏幕」。';
    } else if (kind === 'timeout') {
      el.emptyTitle.textContent = '等待授权超时';
      el.emptySub.textContent = '浏览器一直在等你的授权确认。看看地址栏附近有没有权限提示，允许后点「重试授权」。';
    } else {
      el.emptyTitle.textContent = '无法启动摄像头';
      el.emptySub.textContent = '未知原因。可以点「重试授权」，或改用「共享屏幕」开播。';
    }
  }

  async function initVideo() {
    if (camStream && camStream.getVideoTracks()[0]) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showMediaIssue(window.isSecureContext === false ? 'insecure' : 'nodevice');
      paintMediaState();
      return false;
    }

    try {
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
          audio: false
        }),
        12000,
        'gum-timeout'
      );

      camStream = stream;
      usingScreen = false;
      camOn = true;
      if (el.openTab) el.openTab.hidden = true;
      if (el.retryCam) el.retryCam.hidden = true;
      applyStream(compose());
      refreshMicList();

      const vTrack = stream.getVideoTracks()[0];
      if (vTrack) {
        vTrack.addEventListener('ended', () => {
          camOn = false;
          paintMediaState();
          applyStream(compose());
        });
      }
      return true;
    } catch (err) {
      const kind = classifyMediaError(err);
      showMediaIssue(window.self !== window.top ? 'iframe' : kind);
      camOn = false;
      paintMediaState();
      return false;
    }
  }

  async function initMic(deviceId) {
    if (!deviceId && micStream && micStream.getAudioTracks()[0]) return true;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      micIssue = 'insecure';
      paintMediaState();
      return false;
    }

    try {
      const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      if (deviceId) audio.deviceId = { exact: deviceId };

      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({ audio, video: false }),
        12000,
        'gum-timeout'
      );

      // 换设备时先释放旧的
      if (micStream && micStream !== stream) {
        if (micSource) {
          try { micSource.disconnect(); } catch (err) { /* noop */ }
          micSource = null;
        }
        micStream.getTracks().forEach((t) => t.stop());
      }

      micStream = stream;
      micOn = true;
      micIssue = null;
      preferredMicId = deviceId || '';
      attachMic(stream);
      resumeAudio();
      applyStream(compose());
      refreshMicList();

      const track = stream.getAudioTracks()[0];
      if (track) {
        track.addEventListener('ended', () => {
          micOn = false;
          micStream = null;
          paintMediaState();
          applyStream(compose());
        });
      }
      return true;
    } catch (err) {
      micIssue = classifyMediaError(err);
      micOn = false;
      paintMediaState();
      return false;
    }
  }

  // 同一时间只发一次采集请求
  let mediaPromise = null;
  function ensureMedia() {
    if (hasVideo() && micStream) return Promise.resolve(true);
    if (mediaPromise) return mediaPromise;
    mediaPromise = Promise.all([initVideo(), initMic()])
      .then(() => hasVideo() || !!micStream)
      .finally(() => { mediaPromise = null; });
    return mediaPromise;
  }

  function applyStream(stream) {
    localStream = stream;
    el.preview.srcObject = stream;
    el.preview.play().catch(() => {});

    if (live) syncPeerTracks(stream);
    paintMediaState();
    syncMuted();
  }

  async function syncPeerTracks(stream) {
    for (const [viewerId, pc] of peers) {
      await queuePeerUpdate(pc, async () => {
        let needOffer = false;
        for (const track of stream.getTracks()) {
          const sender = pc.getSenders().find((s) => s.track && s.track.kind === track.kind);
          if (!sender) {
            try {
              pc.addTrack(track, stream);
              needOffer = true;
            } catch (err) { /* noop */ }
          } else if (sender.track !== track) {
            try { await sender.replaceTrack(track); } catch (err) { /* noop */ }
          }
        }
        if (needOffer) renegotiate(viewerId, pc);
      });
      // 换轨后按新源实际尺寸重算，绝不修改观众共用的采集轨分辨率。
      tunePeer(pc);
    }
  }

  async function renegotiate(viewerId, pc) {
    /* 正在协商中就直接发 offer 会抛 InvalidStateError，且这一路观众
       从此永远缺一条轨。这里挂一个待办标记，等回到 stable 再补一次。 */
    if (pc.signalingState !== 'stable') {
      pc.__pendingOffer = true;
      if (!pc.__pendingHooked) {
        pc.__pendingHooked = true;
        pc.addEventListener('signalingstatechange', () => {
          if (pc.signalingState === 'stable' && pc.__pendingOffer) {
            pc.__pendingOffer = false;
            renegotiate(viewerId, pc);
          }
        });
      }
      return;
    }

    try {
      pc.__pendingOffer = false;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      postSignal(viewerId, { sdp: pc.localDescription });
    } catch (err) { /* noop */ }
  }

  function compose() {
    const video = currentVideoTrack();
    const out = new MediaStream();
    if (video) out.addTrack(video);
    if (programTrack) out.addTrack(programTrack);
    return out;
  }

  /* ---------- 按钮 ---------- */

  el.btnCam.addEventListener('click', async () => {
    if (!camStream) {
      const ok = await initVideo();
      if (ok) toast('摄像头已就绪');
      return;
    }
    const track = camStream.getVideoTracks()[0];
    if (!track) return;
    if (!track.enabled && usingScreen === false) {
      track.enabled = true;
      camOn = true;
    } else {
      track.enabled = !track.enabled;
      camOn = track.enabled;
    }
    paintMediaState();
    syncMuted();
  });

  el.btnMic.addEventListener('click', async () => {
    if (!micStream) {
      const ok = await initMic(preferredMicId || undefined);
      toast(ok ? '麦克风已就绪' : micIssueTitle(micIssue));
      return;
    }
    micOn = !micOn;
    if (micGain && audioCtx) {
      micGain.gain.setTargetAtTime(micOn ? 1 : 0, audioCtx.currentTime, 0.015);
    }
    const track = micStream.getAudioTracks()[0];
    if (track) track.enabled = micOn;
    paintMediaState();
    syncMuted();
  });

  if (el.micSelect) {
    el.micSelect.addEventListener('change', async () => {
      const id = el.micSelect.value;
      if (!id) return;
      const ok = await initMic(id);
      toast(ok ? '已切换麦克风' : micIssueTitle(micIssue));
    });
  }

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      refreshMicList();
      paintAudioState();
    });
  }

  el.btnShare.addEventListener('click', async () => {
    if (usingScreen) return stopScreen();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast('这个浏览器不支持共享屏幕，请用 Chrome / Edge');
      return;
    }

    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30, max: 30 } },
          audio: true,
          systemAudio: 'include',
          selfBrowserSurface: 'exclude'
        });
      } catch (err) {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
      }

      // 系统声音原样送出去，不要做降噪/回声消除
      const sharedAudio = stream.getAudioTracks()[0];
      if (sharedAudio && sharedAudio.applyConstraints) {
        sharedAudio.applyConstraints({ echoCancellation: false, noiseSuppression: false, autoGainControl: false })
          .catch(() => {});
      }

      if (!stream.getVideoTracks().length) {
        toast('没有拿到画面，再试一次');
        return;
      }

      screenStream = stream;
      usingScreen = true;
      attachScreenAudio(stream);
      applyStream(compose());

      stream.getVideoTracks()[0].addEventListener('ended', () => stopScreen());
      toast(screenAudioOn ? '正在共享屏幕（含系统声音）' : '正在共享屏幕 · 这次没有带声音');
    } catch (err) {
      const name = err && err.name;
      if (name === 'NotAllowedError') return; // 用户自己取消
      if (name === 'NotSupportedError') toast('这个浏览器不支持共享屏幕音频');
      else toast('屏幕共享失败，换 Chrome / Edge 试试');
    }
  });

  function stopScreen() {
    if (screenSource) {
      try { screenSource.disconnect(); } catch (err) { /* noop */ }
      screenSource = null;
    }
    screenAudioOn = false;
    if (screenStream) {
      screenStream.getTracks().forEach((t) => t.stop());
      screenStream = null;
    }
    usingScreen = false;
    applyStream(compose());
  }

  /* 在新标签页打开（预览框/内嵌场景的逃生通道） */
  if (el.openTab) {
    el.openTab.addEventListener('click', () => {
      const w = window.open(location.href, '_blank', 'noopener');
      if (!w) toast('浏览器拦截了弹窗，请手动复制地址到新标签页打开');
    });
  }

  if (el.retryCam) {
    el.retryCam.addEventListener('click', async () => {
      el.retryCam.disabled = true;
      el.retryCam.textContent = '正在请求…';
      await ensureMedia();
      el.retryCam.textContent = '重试授权';
      el.retryCam.disabled = false;
      if (hasVideo() && micStream) toast('摄像头和麦克风都就绪了');
      else if (hasVideo()) toast('摄像头已就绪，麦克风还没拿到');
      else if (micStream) toast('麦克风已就绪，摄像头还没拿到');
    });
  }

  /* ================= 直播控制 ================= */

  function syncMuted() {
    if (!live) return;
    postStream({
      muted: { audio: !(micOn && micStream) && !screenAudioOn, video: !camOn && !usingScreen }
    }).catch(() => {});
  }

  function paintLiveState() {
    el.badge.classList.toggle('is-off', !live);
    el.badge.innerHTML = `<i></i>${live ? 'ON AIR' : 'STANDBY'}`;
    el.rec.hidden = !live;
    el.goLive.classList.toggle('is-live', live);
    el.goLive.textContent = live ? '结束直播' : '开始直播';
    el.goLive.disabled = false;
    el.stStatus.textContent = live ? '直播中' : '未开播';
    el.stStatus.className = `v ${live ? 'ok' : ''}`;
    el.hint.textContent = live
      ? '观众端是点对点直连：每多一位观众，你的上行带宽就多占用一份。人多时请适当降低分辨率。'
      : '先说清楚：这是点对点直连，没有中心服务器转码。主播上行带宽 = 每位观众一份，适合几十人以内的自留地直播。';
    if (evicted) {
      el.goLive.classList.remove('is-live');
      el.goLive.disabled = true;
      el.goLive.textContent = '已在别处开播';
      el.stStatus.textContent = '已在别处开播';
      el.stStatus.className = 'v';
      el.stBitrate.textContent = '—';
      el.stSend.textContent = '—';
    }
  }

  el.goLive.addEventListener('click', async () => {
    if (evicted) {
      toast('这个开播台已被别处接管，要点上面的「在这里继续开播」才能抢回来');
      return;
    }
    if (keyRequired && !streamKey) {
      const typed = el.keyInput ? el.keyInput.value.trim() : '';
      const ok = typed ? await useKey(typed) : false;
      if (!ok) {
        toast(typed ? '开播口令不对' : '先填开播口令才能开播');
        if (el.keyInput) el.keyInput.focus();
        return;
      }
      connect();
    }

    if (!hasVideo() && !micStream) {
      el.goLive.disabled = true;
      el.goLive.textContent = '请求设备…';
      await ensureMedia();
      el.goLive.textContent = live ? '结束直播' : '开始直播';
      el.goLive.disabled = false;
      if (!hasVideo() && !micStream) {
        if (window.self !== window.top) {
          toast('预览框拿不到摄像头，请点预览区里的「在新标签页打开」');
        } else {
          toast('还没有画面和声音：请允许摄像头/麦克风，或先点「共享屏幕」');
        }
        return;
      }
    }
    el.goLive.disabled = true;

    try {
      if (!live) {
        const res = await postStream({
          live: true,
          title: el.title.value.trim(),
          muted: { audio: !(micOn && micStream) && !screenAudioOn, video: !camOn && !usingScreen }
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          if (res.status === 401) {
            streamKey = '';
            localStorage.removeItem('luma:key');
            if (el.keyRow) el.keyRow.hidden = false;
            setKeyState('口令不对', 'bad');
            if (el.keyInput) el.keyInput.focus();
          }
          toast(data.error || '开播失败');
          el.goLive.disabled = false;
          return;
        }
        live = true;
        paintLiveState();
        toast('已开播，把观看链接发给观众吧');
      } else {
        await postStream({ live: false });
        live = false;
        startedAt = null;
        closeAllPeers();
        paintLiveState();
        toast('已结束直播');
      }
    } catch (err) {
      toast('网络异常，操作未生效');
    } finally {
      el.goLive.disabled = false;
    }
  });

  /* 被顶替后，人在这里明确点一下 → 强行接管（服务端带 takeover=1 才认） */
  if (el.takeOverBtn) {
    el.takeOverBtn.addEventListener('click', async () => {
      el.takeOverBtn.disabled = true;
      el.takeOverBtn.textContent = '正在接管…';
      setEvicted(false);
      await connect(true);
      el.takeOverBtn.disabled = false;
      el.takeOverBtn.textContent = '在这里继续开播';
      toast('已接管这个开播台');
    });
  }

  /* 标题改动实时同步 */
  let titleTimer = null;
  el.title.addEventListener('input', () => {
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => {
      if (!live) return;
      postStream({ title: el.title.value.trim() }).catch(() => {});
    }, 400);
  });

  /* ================= 点对点连接 ================= */

  function postSignal(to, data) {
    post('/api/signal', { from: hostId, to, data }).catch(() => {});
  }

  function paintConnections() {
    const counts = { direct: 0, relay: 0 };
    const relayNodes = new Map();   // 中继线路名 → 路数
    if (live) for (const pc of peers.values()) {
      /* 只统计已经连上的：连不上的不计入，避免出现「检测中」这种悬着的状态 */
      if (pc.connectionState !== 'connected') continue;
      const type = pc.__connectionType === 'relay' ? 'relay' : 'direct';
      counts[type] += 1;
      if (type === 'relay' && pc.__relayNode) {
        relayNodes.set(pc.__relayNode, (relayNodes.get(pc.__relayNode) || 0) + 1);
      }
    }
    let relayPart = `TURN ${counts.relay}路`;
    if (relayNodes.size) {
      relayPart += `（${[...relayNodes].map(([k, v]) => `${k} ${v}`).join(' / ')}）`;
    }
    const text = `P2P ${counts.direct}路 / ${relayPart}`;
    if (el.stConnections.textContent !== text) el.stConnections.textContent = text;
  }

  function closePeer(viewerId) {
    const pc = peers.get(viewerId);
    if (!pc) return;
    try {
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
    } catch (err) { /* noop */ }
    peers.delete(viewerId);
    paintConnections();
  }

  function closeAllPeers() {
    for (const id of Array.from(peers.keys())) closePeer(id);
    viewerLines.clear();
    lastBytes = null;
    el.stBitrate.textContent = '—';
  }

  /* ================= 单主播保护：被顶替时安静退场 ================= */

  /* 摄像头/麦克风一起放掉：被顶替的标签页不该继续占着设备，也不该亮着指示灯 */
  function releaseCapture() {
    if (usingScreen) {
      try { stopScreen(); } catch (err) { /* noop */ }
    }
    if (camStream) {
      camStream.getTracks().forEach((t) => { try { t.stop(); } catch (err) { /* noop */ } });
      camStream = null;
    }
    camOn = false;
    if (micStream) {
      micStream.getTracks().forEach((t) => { try { t.stop(); } catch (err) { /* noop */ } });
      micStream = null;
    }
    micOn = false;
    applyStream(compose());
    paintMediaState();
  }

  function setEvicted(on) {
    evicted = Boolean(on);
    if (el.taken) el.taken.hidden = !evicted;
    paintLiveState();
  }

  /* 别处的开播台凭同一个口令上线了：这边立刻停播，且不再自动重连。
     否则两边会互相顶替，每个 offer 都被打断，观众永远黑屏。 */
  function handleHostTaken() {
    if (evicted) return;
    evicted = true;
    clearTimeout(reconnectTimer);
    if (es) {
      try { es.close(); } catch (err) { /* noop */ }
      es = null;
    }
    live = false;
    startedAt = null;
    closeAllPeers();
    releaseCapture();
    setEvicted(true);
    toast('已在别处开播，这个标签页已停止推流');
  }

  /* 每个观众一条独立 RTCPeerConnection，天然可以单独设档。
     观众端每 3 秒回报一次丢包/RTT，这里据此调该观众的码率上限。 */
  /* 固定发送参数：不按网络分级，所有观众统一 720p/30fps/1200kbps。 */
  const FIXED_BITRATE = 1200000;
  const TIER_RANK = { low: 0, mid: 1, high: 2 };

  function tierFor(stats) {
    const loss = Number(stats && stats.loss) || 0;
    const rtt = Number(stats && stats.rtt) || 0;
    let tier = 'high';
    if (loss > 0.08 || rtt > 500) tier = 'low';
    else if (loss > 0.03 || rtt > 250) tier = 'mid';
    /* 走 TURN 中继的观众：流量过服务器，封顶 mid，别拿服务器的带宽换清晰度 */
    if (stats && (stats.relay || stats.connectionType === 'relay') && TIER_RANK[tier] > TIER_RANK.mid) return 'mid';
    return tier;
  }

  function applyViewerStats(viewerId, stats) {
    const pc = peers.get(viewerId);
    if (!pc || pc.connectionState !== 'connected') return;
    pc.__lastStatsAt = Date.now();
    pc.__connectionType = stats && ['direct', 'relay', 'unknown'].includes(stats.connectionType)
      ? stats.connectionType : stats && stats.relay === true ? 'relay' : 'unknown';
    pc.__relay = pc.__connectionType === 'relay' || Boolean(stats && stats.relay);
    /* 观众会把中继候选的地址带上来，换成节点名显示，方便确认走的是哪条线路 */
    pc.__relayNode = pc.__relay && stats.relayAddr ? relayLabel(stats.relayAddr) : '';
    paintConnections();

    /* 固定发送档位：只记录链路状态，不因丢包/RTT 改码率或重建连接。 */
    return;
  }

  const VIDEO_LONG_EDGE = [1280, 960, 640];
  const VIDEO_TARGET_FPS = 30;
  const VIDEO_SWITCH_COOLDOWN = 10000;

  // replaceTrack 与 get/setParameters 共用队列，避免旧 transactionId 引发
  // InvalidModificationError；执行时才读取最新 tier，网络调档不会抹掉性能档。
  function queuePeerUpdate(pc, update) {
    pc.__senderUpdate = (pc.__senderUpdate || Promise.resolve()).then(async () => {
      if (pc.signalingState !== 'closed') await update();
    }).catch(() => {});
    return pc.__senderUpdate;
  }

  function videoState(pc, track) {
    if (!pc.__videoState || pc.__videoState.trackId !== track.id) {
      pc.__videoState = {
        trackId: track.id, step: 0, bad: 0, good: 0, switchedAt: -Infinity,
        samples: new Map(), sources: new Map(), fps: null, resolutions: []
      };
    }
    return pc.__videoState;
  }

  async function tuneSender(pc, sender) {
    const state = videoState(pc, sender.track);
    const settings = sender.track.getSettings ? sender.track.getSettings() : {};
    const index = 0;
    const longest = Math.max(settings.width || 0, settings.height || 0);
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings.forEach((encoding) => {
      encoding.maxBitrate = FIXED_BITRATE;
      encoding.maxFramerate = VIDEO_TARGET_FPS;
      /* 固定原始 720p，不根据丢包/RTT/编码压力改变分辨率。 */
      encoding.scaleResolutionDownBy = Math.max(1, longest / 1280);
    });
    params.degradationPreference = 'maintain-framerate';
    await sender.setParameters(params);
  }

  function tunePeer(pc) {
    return queuePeerUpdate(pc, async () => {
      for (const sender of pc.getSenders()) {
        if (sender.track && sender.track.kind === 'video') await tuneSender(pc, sender);
      }
    });
  }

  function updateVideoStats(pc, report, now) {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (!sender) return;
    const track = sender.track;
    const state = videoState(pc, track);
    /* 固定码率/分辨率，不做动态降级或升档；保留统计仅供状态展示。 */
    state.bad = 0;
    state.good = 0;
    const sources = new Map();
    report.forEach((r) => {
      if (r.type !== 'media-source' || (r.kind || r.mediaType) !== 'video') return;
      if (r.trackIdentifier && r.trackIdentifier !== track.id) return;
      let fps = Number.isFinite(r.framesPerSecond) ? r.framesPerSecond : null;
      const frames = Number.isFinite(r.frames) ? r.frames : r.framesCaptured;
      const previous = state.sources.get(r.id);
      if (previous && Number.isFinite(frames) && frames >= previous.frames && r.timestamp > previous.at) {
        fps = (frames - previous.frames) * 1000 / (r.timestamp - previous.at);
      }
      if (Number.isFinite(frames)) state.sources.set(r.id, { frames, at: r.timestamp });
      sources.set(r.id, fps);
    });

    let fps = 0;
    let measured = false;
    let limited = false;
    let sourceReady = false;
    const resolutions = new Set();
    const samples = new Map();
    report.forEach((r) => {
      if (r.type !== 'outbound-rtp' || (r.kind || r.mediaType) !== 'video' || r.isRemote) return;
      if (r.frameWidth && r.frameHeight) resolutions.add(`${r.frameWidth}×${r.frameHeight}`);
      const previous = state.samples.get(r.id);
      if (!Number.isFinite(r.framesEncoded)) return;
      samples.set(r.id, { frames: r.framesEncoded, at: r.timestamp });
      if (!previous || r.framesEncoded < previous.frames || r.timestamp <= previous.at) return;
      // 必须用累计编码帧的增量；静态 framesPerSecond 可能陈旧，不能当作达标保证。
      fps += (r.framesEncoded - previous.frames) * 1000 / (r.timestamp - previous.at);
      measured = true;
      limited = limited || r.qualityLimitationReason === 'cpu' || r.qualityLimitationReason === 'bandwidth';
      const captureFps = sources.has(r.mediaSourceId)
        ? sources.get(r.mediaSourceId) : (sources.size === 1 ? sources.values().next().value : null);
      sourceReady = sourceReady || (captureFps !== null && captureFps >= 26);
    });
    state.samples = samples;
    state.resolutions = Array.from(resolutions);
    state.fps = measured ? fps : null;
    if (!measured || !track.enabled || track.muted || track.readyState === 'ended') {
      state.bad = 0;
      state.good = 0;
      return;
    }

    // 静态屏幕、低帧率摄像头或缺失采集统计时，不把源端缺帧误判为编码压力。
    // 明确的 CPU/带宽限制仍可降档；30fps 是目标，不是设备/网络上的下限承诺。
    const bad = limited || (fps < 26 && sourceReady);
    state.bad = bad ? state.bad + 1 : 0;
    state.good = fps >= 29 && !limited ? state.good + 1 : 0;
    if (now - state.switchedAt < VIDEO_SWITCH_COOLDOWN) return;
    const baseline = 2 - TIER_RANK[pc.__tier || 'high'];
    return; /* 固定发送档位：不再根据视频统计调整分辨率 */
  }

  /* 主播不再写死一条线路：每个观众用他自己选的那份 ICE 配置建 peer。
     这样 p2p 观众不会撞上主播的 relay-only 候选，上海/香港也能各走各的。 */
  function iceForViewer(viewerId) {
    const line = viewerLines.get(viewerId) || ICE.line || 'p2p';
    const cfg = ICE.byLine && ICE.byLine[line];
    return {
      iceServers: cfg && Array.isArray(cfg.iceServers) && cfg.iceServers.length
        ? cfg.iceServers : ICE.iceServers,
      iceTransportPolicy: cfg && cfg.iceTransportPolicy ? cfg.iceTransportPolicy : ICE.iceTransportPolicy
    };
  }

  async function connectViewer(viewerId) {
    if (!localStream || !live) return;
    closePeer(viewerId);

    const pc = new RTCPeerConnection(iceForViewer(viewerId));
    pc.__tier = 'high';
    pc.__relay = false;
    pc.__relayNode = '';
    pc.__connectionType = 'unknown';
    pc.__lastStatsAt = Date.now();
    peers.set(viewerId, pc);
    paintConnections();

    localStream.getTracks().forEach((track) => {
      try { pc.addTrack(track, localStream); } catch (err) { /* noop */ }
    });

    // 采集与发送均以 30fps 为目标；带宽/编码压力下优先牺牲本路分辨率。
    await tunePeer(pc);

    pc.onicecandidate = (e) => {
      if (e.candidate) postSignal(viewerId, { candidate: e.candidate });
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s !== 'connected') {
        pc.__connectionType = 'unknown';
        pc.__relay = false;
        pc.__relayNode = '';
      }
      paintConnections();
      if (s === 'connected') tunePeer(pc);
      if (s === 'failed' || s === 'closed') {
        closePeer(viewerId);
      }
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      postSignal(viewerId, { sdp: pc.localDescription });
    } catch (err) {
      closePeer(viewerId);
    }
  }

  /* ================= 事件流 ================= */

  let reconnectTimer = null;

  /* 连之前先问一句：这个 id 是不是已经被别处的开播台顶替了？
     EventSource 拿不到 403 的响应体，只能靠这个接口判断该不该安静退场。 */
  async function takenByOther() {
    try {
      const r = await fetch(`/api/host-status?id=${encodeURIComponent(hostId)}`, { cache: 'no-store' });
      if (!r.ok) return false;
      const s = await r.json();
      return Boolean(s && s.taken);
    } catch (err) {
      return false; // 网络问题就当没事，照常连
    }
  }

  async function connect(takeover) {
    clearTimeout(reconnectTimer);
    /* 已经被顶替：除非人来点「在这里继续开播」，否则不再抢 */
    if (evicted && !takeover) return;

    if (!takeover && (await takenByOther())) {
      handleHostTaken();
      return;
    }
    if (takeover) setEvicted(false);

    if (es) {
      try { es.close(); } catch (err) { /* noop */ }
      es = null;
    }

    const q = `role=host&id=${encodeURIComponent(hostId)}&name=Luma`;
    /* TODO(安全)：EventSource 不能带 body，口令只能留在 query 里，会进反代访问日志。
       等接上「/api/auth 换短期 token → SSE 带 token」后改成 token。 */
    const tk = takeover ? '&takeover=1' : '';
    es = new EventSource(`/api/events?${q}&key=${encodeURIComponent(streamKey)}${tk}`);

    /* 服务端切断这条连接之前会先发这一帧：说明不是网络抖动，是被接管了 */
    es.addEventListener('host-taken', () => handleHostTaken());

    es.addEventListener('welcome', (e) => {
      const data = JSON.parse(e.data);
      applyIce(data.ice);
      if (data.title) el.title.value = data.title;
      if (data.startedAt) startedAt = data.startedAt;
      if (keyRequired) setKeyState('口令正确', 'ok');
      if (data.live) {
        live = true;
        paintLiveState();
        // 断线重连后主动重建所有连接
        postStream({ live: true, title: el.title.value.trim() }).catch(() => {});
      } else {
        paintLiveState();
      }
      el.viewers.textContent = data.viewers || 0;
      el.stViewers.textContent = data.viewers || 0;
    });

    es.addEventListener('state', (e) => {
      const data = JSON.parse(e.data);
      if (typeof data.viewers === 'number') {
        el.viewers.textContent = data.viewers;
        el.stViewers.textContent = data.viewers;
      }
      if (data.startedAt) startedAt = data.startedAt;
      if (typeof data.live === 'boolean' && data.live !== live) {
        live = data.live;
        paintLiveState();
        if (!live) closeAllPeers();
      }
    });

    es.addEventListener('go-live', (e) => {
      let data = {};
      try { data = JSON.parse(e.data); } catch (err) { /* noop */ }
      const viewers = Array.isArray(data.viewers)
        ? data.viewers
        : Array.from(peers.keys()).map((id) => ({ id, line: viewerLines.get(id) || ICE.line }));
      viewers.forEach((v) => {
        const vid = typeof v === 'string' ? v : v && v.id;
        if (!vid) return;
        if (v && v.line) viewerLines.set(vid, v.line);
        connectViewer(vid);
      });
    });

    es.addEventListener('viewer-joined', (e) => {
      const { id, line } = JSON.parse(e.data) || {};
      if (id) {
        if (line) viewerLines.set(id, line);
        connectViewer(id);
      }
    });

    es.addEventListener('viewer-left', (e) => {
      const { id } = JSON.parse(e.data) || {};
      if (id) {
        viewerLines.delete(id);
        closePeer(id);
      }
    });

    es.addEventListener('viewer-line', (e) => {
      const { id, line } = JSON.parse(e.data) || {};
      if (!id || !line) return;
      viewerLines.set(id, line);
      /* ICE 只在 new RTCPeerConnection 时读取，换线路必须重建这一路 */
      if (peers.has(id)) connectViewer(id);
    });

    es.addEventListener('stream-ended', () => {
      live = false;
      startedAt = null;
      closeAllPeers();
      paintLiveState();
    });

    es.addEventListener('signal', async (e) => {
      const { from, data } = JSON.parse(e.data) || {};
      if (!from || !data) return;

      if (data.request === 'restart') {
        await connectViewer(from);
        return;
      }

      // 观众回报的链路质量：只调这一路观众的码率，不影响别人
      if (data.stats) {
        applyViewerStats(from, data.stats);
        return;
      }

      const pc = peers.get(from);
      if (!pc) return;

      try {
        if (data.sdp && data.sdp.type === 'answer') {
          if (pc.signalingState !== 'stable') await pc.setRemoteDescription(data.sdp);
        } else if (data.candidate) {
          if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        }
      } catch (err) { /* 单个观众协商失败不影响其他人 */ }
    });

    es.addEventListener('notice', (e) => {
      let data = {};
      try { data = JSON.parse(e.data); } catch (err) { /* noop */ }
      if (data && data.text) toast(data.text);
    });

    es.onerror = async () => {
      if (evicted) return;                                    // 已被接管，别再抢
      if (!es || es.readyState !== EventSource.CLOSED) return;

      /* 被别处顶替时服务端回 403，EventSource 直接 CLOSED 且自己不再重连。
         先确认是不是「被接管」：是就安静退场，别每 2.5 秒回来顶一次。 */
      if (await takenByOther()) {
        handleHostTaken();
        return;
      }

      /* 口令错 / 被限速时 EventSource 不会自动重连，这里先分辨原因，
         否则就会每 2.5 秒拿错口令去撞一次 401。 */
      if (keyRequired) {
        try {
          const r = await post('/api/auth', { key: streamKey });
          if (r.status === 401 || r.status === 429) {
            if (r.status === 429) {
              const data = await r.json().catch(() => ({}));
              const wait = Number(data.retryAfter) || 60;
              setKeyState(`${wait} 秒后重试`, 'bad');
              toast(`口令尝试太频繁，${wait} 秒后自动重试`);
              clearTimeout(reconnectTimer);
              reconnectTimer = setTimeout(connect, wait * 1000);
              return;
            }
            setKeyState('口令不对', 'bad');
            if (el.keyRow) el.keyRow.hidden = false;
            if (el.keyInput) el.keyInput.focus();
            toast('开播口令不对，已暂停重连');
            return;
          }
        } catch (err) { /* 网络问题，照常重试 */ }
      }

      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 2500);
    };
  }

  /* ================= 状态刷新 ================= */

  function fmt(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const p = (n) => String(n).padStart(2, '0');
    return `${p(Math.floor(total / 3600))}:${p(Math.floor((total % 3600) / 60))}:${p(total % 60)}`;
  }

  let statsPending = false;
  setInterval(async () => {
    paintConnections();
    el.stTime.textContent = live && startedAt ? fmt(Date.now() - startedAt) : '00:00:00';
    el.stRes.textContent = resolutionText();

    if (!peers.size || !live) {
      el.stBitrate.textContent = '—';
      if (el.stSend) el.stSend.textContent = live ? '等待观众 · 目标30 fps' : '—';
      lastBytes = null;
      return;
    }

    if (statsPending) return;
    statsPending = true;
    try {
      let bytes = 0;
      const sending = [];
      for (const pc of peers.values()) {
        if (pc.connectionState !== 'connected') continue;
        try {
          const report = await pc.getStats();
          if (!live || !Array.from(peers.values()).includes(pc)) continue;
          updateVideoStats(pc, report, performance.now());
          if (pc.__videoState) sending.push(pc.__videoState);
          report.forEach((r) => {
            if (r.type === 'outbound-rtp' && (r.kind || r.mediaType) === 'video' && typeof r.bytesSent === 'number') {
              bytes += r.bytesSent;
            }
          });
        } catch (err) { /* noop */ }
      }

      if (!live || !peers.size) return;
      const fpsValues = sending.map((s) => s.fps).filter((fps) => fps !== null);
      const resolutions = new Map();
      sending.forEach((s) => s.resolutions.forEach((res) => resolutions.set(res, (resolutions.get(res) || 0) + 1)));
      const fpsText = fpsValues.length
        ? `${Math.round(Math.min(...fpsValues))}–${Math.round(Math.max(...fpsValues))} fps（目标30）` : '帧率采样中（目标30）';
      if (el.stSend) {
        el.stSend.textContent = (resolutions.size
          ? `${Array.from(resolutions, ([res, count]) => `${res}（${count}路）`).join(' / ')} · ` : '') + fpsText;
      }
      const now = performance.now();
      if (lastBytes !== null && now > lastStatAt) {
        const kbps = Math.max(0, Math.round(((bytes - lastBytes) * 8) / ((now - lastStatAt) / 1000) / 1000));
        let degraded = 0;
        let relayed = 0;
        for (const pc of peers.values()) {
          if (pc.connectionState !== 'connected') continue;
          if (pc.__relay) relayed += 1;
          if ((pc.__tier && pc.__tier !== 'high') || (pc.__videoState && pc.__videoState.step > 0)) degraded += 1;
        }
        el.stBitrate.textContent =
          `${kbps} kbps · ${peers.size} 路` +
          (relayed ? ` · ${relayed} 路中继` : '') +
          (degraded ? ` · ${degraded} 路降档` : '');
      }
      lastBytes = bytes;
      lastStatAt = now;
    } finally {
      statsPending = false;
    }
  }, 2000);

  /* ================= 分享链接 ================= */

  el.share.value = `${location.origin}/${location.search}`;
  el.copy.addEventListener('click', async () => {
    const url = el.share.value;
    try {
      await navigator.clipboard.writeText(url);
      toast('链接已复制');
    } catch (err) {
      el.share.select();
      try { document.execCommand('copy'); toast('链接已复制'); }
      catch (e) { toast('复制失败，请手动选择'); }
    }
  });

  /* ================= 启动 ================= */

  /* 校验并记住口令。成功返回 true。 */
  async function useKey(value) {
    const v = String(value || '').trim();
    if (!v) return false;
    setKeyState('校验中…');
    try {
      /* POST 而不是 GET：口令放 body，不进反向代理的访问日志 */
      const r = await post('/api/auth', { key: v });
      if (r.status === 429) {
        setKeyState('尝试太频繁，稍后再试', 'bad');
        return false;
      }
      if (!r.ok) {
        setKeyState('口令不对', 'bad');
        return false;
      }
    } catch (err) {
      setKeyState('网络异常', 'bad');
      return false;
    }
    streamKey = v;
    try { localStorage.setItem('luma:key', v); } catch (err) { /* 隐私模式下可能禁用 */ }
    setKeyState('口令正确', 'ok');
    return true;
  }

  if (el.keyInput) {
    el.keyInput.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (await useKey(el.keyInput.value)) {
        toast('口令已保存，开播通道已连接');
        connect();
      }
    });
  }

  async function boot() {
    el.goLive.textContent = '开始直播';
    ensureAudioGraph();
    resumeAudio();
    refreshMicList();
    paintMediaState();
    paintLiveState();

    try {
      const cfg = await fetch('/api/config').then((r) => r.json());
      keyRequired = Boolean(cfg && cfg.requireKey);
    } catch (err) {
      keyRequired = false;
    }

    if (keyRequired) {
      if (el.keyRow) el.keyRow.hidden = false;
      if (el.keyInput) el.keyInput.value = streamKey;

      if (!streamKey) {
        setKeyState('需要口令', 'bad');
        ensureMedia();
        if (el.keyInput) el.keyInput.focus();
        return; // 没口令不连 SSE：host 身份是要凭口令占的
      }

      const ok = await useKey(streamKey);
      if (!ok) {
        streamKey = '';
        try { localStorage.removeItem('luma:key'); } catch (err) { /* noop */ }
        ensureMedia();
        if (el.keyInput) el.keyInput.focus();
        return;
      }
    }

    ensureMedia();
    connect();
  }

  boot();
})();
