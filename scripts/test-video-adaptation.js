'use strict';

// 仅执行实际业务函数，不启动 DOM、浏览器、摄像头或网络服务。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'public', 'studio.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const functions = [
  'tierFor', 'applyViewerStats', 'queuePeerUpdate', 'videoState',
  'tuneSender', 'tunePeer', 'updateVideoStats'
];
const constants = [
  'TIER_BITRATE', 'TIER_RANK', 'VIDEO_LONG_EDGE',
  'VIDEO_TARGET_FPS', 'VIDEO_SWITCH_COOLDOWN'
];

function extract(pattern, name) {
  const match = source.match(pattern);
  assert.ok(match, `未找到业务定义 ${name}，请同步测试提取入口`);
  return match[0];
}

const definitions = constants.map((name) => extract(
  new RegExp(`^  const ${name} = .*;$`, 'm'), name
)).concat(functions.map((name) => extract(
  new RegExp(`^  (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}`, 'm'), name
)));
const peers = new Map();
const context = vm.createContext({ peers });
vm.runInContext(`${definitions.join('\n')}\nthis.api = { ${functions.join(', ')} };`, context, {
  filename: sourcePath,
  timeout: 1000
});
const api = context.api;

function fixture({ width = 1280, height = 720, tier = 'high', encodings = [{}] } = {}) {
  let parameters = { encodings };
  const calls = [];
  const track = {
    id: 'video-source', kind: 'video', enabled: true, muted: false, readyState: 'live',
    getSettings: () => ({ width, height, frameRate: 30 })
  };
  const sender = {
    track,
    getParameters: () => structuredClone(parameters),
    setParameters: async (value) => {
      parameters = structuredClone(value);
      calls.push(parameters);
    }
  };
  const pc = { __tier: tier, signalingState: 'stable', getSenders: () => [sender] };
  let timestamp = 0;
  let frames = 0;
  return {
    pc, sender, track, calls,
    parameters: () => parameters,
    sample: async ({ fps = 30, sourceFps = 30, reason = 'none', advertisedFps = fps, elapsed = 2000 } = {}) => {
      timestamp += elapsed;
      frames += fps * elapsed / 1000;
      const report = [{
        id: 'outbound-video', type: 'outbound-rtp', kind: 'video',
        timestamp, framesEncoded: frames, framesPerSecond: advertisedFps,
        qualityLimitationReason: reason, mediaSourceId: 'capture-video',
        frameWidth: width, frameHeight: height
      }];
      if (sourceFps !== null) report.push({
        id: 'capture-video', type: 'media-source', kind: 'video',
        trackIdentifier: sender.track.id, timestamp, framesPerSecond: sourceFps
      });
      api.updateVideoStats(pc, report, timestamp);
      await pc.__senderUpdate;
      return pc.__videoState;
    }
  };
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`); }

for (const [tier, scale, bitrate] of [
  ['high', 1, 2500000], ['mid', 4 / 3, 1200000], ['low', 2, 600000]
]) {
  test(`720p ${tier} 档保持30fps并按目标分辨率缩放`, async () => {
    const f = fixture({ tier });
    await api.tunePeer(f.pc);
    const params = f.parameters();
    assert.equal(params.degradationPreference, 'maintain-framerate');
    assert.equal(params.encodings[0].maxFramerate, 30);
    assert.equal(params.encodings[0].maxBitrate, bitrate);
    near(params.encodings[0].scaleResolutionDownBy, scale);
  });
}

test('小源不放大，竖屏按最长边缩放', async () => {
  for (const tier of ['high', 'mid', 'low']) {
    const small = fixture({ width: 320, height: 180, tier });
    await api.tunePeer(small.pc);
    assert.equal(small.parameters().encodings[0].scaleResolutionDownBy, 1);
  }
  const portrait = fixture({ width: 720, height: 1280, tier: 'mid' });
  await api.tunePeer(portrait.pc);
  near(portrait.parameters().encodings[0].scaleResolutionDownBy, 4 / 3);
});

test('所有encoding都设置目标，保留已有编码参数', async () => {
  const f = fixture({ encodings: [{ rid: 'a', active: true }, { rid: 'b', active: false }] });
  await api.tunePeer(f.pc);
  assert.equal(f.parameters().encodings.length, 2);
  for (const encoding of f.parameters().encodings) {
    assert.equal(encoding.maxFramerate, 30);
    assert.equal(encoding.scaleResolutionDownBy, 1);
  }
  assert.equal(f.parameters().encodings[1].active, false);
  const empty = fixture({ encodings: [] });
  await api.tunePeer(empty.pc);
  assert.equal(empty.parameters().encodings[0].maxFramerate, 30);
});

test('性能降档不改网络tier或码率，网络重新调档不清空性能档', async () => {
  const f = fixture();
  const state = api.videoState(f.pc, f.track);
  state.step = 1;
  await api.tunePeer(f.pc);
  assert.equal(f.pc.__tier, 'high');
  assert.equal(f.parameters().encodings[0].maxBitrate, 2500000);
  near(f.parameters().encodings[0].scaleResolutionDownBy, 4 / 3);
  peers.set('performance-test', f.pc);
  try {
    api.applyViewerStats('performance-test', { loss: 0.04, rtt: 40 });
    await f.pc.__senderUpdate;
    assert.equal(f.pc.__tier, 'mid');
    assert.equal(f.pc.__videoState.step, 1);
    assert.equal(f.parameters().encodings[0].scaleResolutionDownBy, 2);
    for (let i = 0; i < 3; i += 1) api.applyViewerStats('performance-test', { loss: 0, rtt: 40 });
    await f.pc.__senderUpdate;
    assert.equal(f.pc.__tier, 'high');
    assert.equal(f.pc.__videoState.step, 1);
    near(f.parameters().encodings[0].scaleResolutionDownBy, 4 / 3);
  } finally { peers.delete('performance-test'); }
});

test('中继仍封顶mid，差网络仍可降low', async () => {
  assert.equal(api.tierFor({ relay: true, loss: 0, rtt: 30 }), 'mid');
  assert.equal(api.tierFor({ relay: true, loss: 0.1, rtt: 30 }), 'low');
  const f = fixture({ tier: 'low' });
  peers.set('relay-test', f.pc);
  try {
    for (let i = 0; i < 6; i += 1) api.applyViewerStats('relay-test', { relay: true, loss: 0, rtt: 30 });
    await f.pc.__senderUpdate;
    assert.equal(f.pc.__tier, 'mid');
    assert.equal(f.parameters().encodings[0].maxBitrate, 1200000);
  } finally { peers.delete('relay-test'); }
});

test('累计编码低fps加CPU压力连续两次才降档', async () => {
  const f = fixture();
  await f.sample({ fps: 15, reason: 'cpu', advertisedFps: 30 });
  assert.equal(f.pc.__videoState.step, 0);
  await f.sample({ fps: 15, reason: 'cpu', advertisedFps: 30 });
  assert.equal(f.pc.__videoState.step, 0);
  await f.sample({ fps: 15, reason: 'cpu', advertisedFps: 30 });
  assert.equal(f.pc.__videoState.step, 1);
  assert.equal(f.pc.__videoState.fps, 15);
  assert.equal(f.pc.__tier, 'high');
  near(f.parameters().encodings[0].scaleResolutionDownBy, 4 / 3);
});

test('编码低fps且源充足可降档，缺源统计或静态低fps不盲降', async () => {
  for (const sourceFps of [null, 2, 15]) {
    const f = fixture();
    for (let i = 0; i < 10; i += 1) await f.sample({ fps: 2, sourceFps });
    assert.equal(f.pc.__videoState.step, 0, `源fps=${sourceFps}不应误降档`);
  }
  const active = fixture();
  for (let i = 0; i < 3; i += 1) await active.sample({ fps: 15, sourceFps: 30 });
  assert.equal(active.pc.__videoState.step, 1);
});

test('降档冷却防抖，稳定五次逐级恢复且恢复后仍有冷却', async () => {
  const f = fixture();
  for (let i = 0; i < 3; i += 1) await f.sample({ fps: 15, reason: 'cpu' });
  assert.equal(f.pc.__videoState.step, 1);
  for (let i = 0; i < 4; i += 1) await f.sample({ fps: 15, reason: 'cpu' });
  assert.equal(f.pc.__videoState.step, 1, '冷却结束前不可继续降档');
  await f.sample({ fps: 15, reason: 'cpu' });
  assert.equal(f.pc.__videoState.step, 2);
  assert.equal(f.parameters().encodings[0].scaleResolutionDownBy, 2);
  for (let i = 0; i < 4; i += 1) await f.sample();
  assert.equal(f.pc.__videoState.step, 2, '未满五次稳定不能恢复');
  await f.sample();
  assert.equal(f.pc.__videoState.step, 1);
  for (let i = 0; i < 4; i += 1) await f.sample();
  assert.equal(f.pc.__videoState.step, 1);
  await f.sample();
  assert.equal(f.pc.__videoState.step, 0);
  assert.equal(f.parameters().encodings[0].scaleResolutionDownBy, 1);
});

test('一次不稳定打断恢复计数', async () => {
  const f = fixture();
  api.videoState(f.pc, f.track).step = 1;
  await f.sample();
  for (let i = 0; i < 4; i += 1) await f.sample();
  await f.sample({ fps: 20, sourceFps: 20 });
  for (let i = 0; i < 4; i += 1) await f.sample();
  assert.equal(f.pc.__videoState.step, 1);
  await f.sample();
  assert.equal(f.pc.__videoState.step, 0);
});

test('关闭、静音或结束的轨道不根据低fps降档', async () => {
  for (const patch of [{ enabled: false }, { muted: true }, { readyState: 'ended' }]) {
    const f = fixture();
    Object.assign(f.track, patch);
    for (let i = 0; i < 5; i += 1) await f.sample({ fps: 1, reason: 'cpu' });
    assert.equal(f.pc.__videoState.step, 0);
  }
});

test('独立观众状态互不影响，替换视频源后重置性能状态', async () => {
  const first = fixture();
  const second = fixture();
  for (let i = 0; i < 3; i += 1) await first.sample({ fps: 15, reason: 'cpu' });
  await api.tunePeer(second.pc);
  assert.equal(first.pc.__videoState.step, 1);
  assert.equal(second.pc.__videoState.step, 0);
  assert.equal(second.parameters().encodings[0].scaleResolutionDownBy, 1);
  first.sender.track = { ...first.track, id: 'replacement-video' };
  await api.tunePeer(first.pc);
  assert.equal(first.pc.__videoState.trackId, 'replacement-video');
  assert.equal(first.pc.__videoState.step, 0);
});

(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try {
      await run();
      console.log(`通过 ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`失败 ${name}\n${error.stack}`);
    }
  }
  console.log(`视频自适应测试：${tests.length - failures}/${tests.length} 通过`);
  process.exitCode = failures ? 1 : 0;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
