# LUMA Live

浏览器互连的直播间：**打开网页就能开播**，不需要 OBS、不需要 RTMP、不需要转码服务器。
主播与观众之间通过 WebRTC 点对点传输音视频，服务器只负责信令、在线状态与聊天。

灵感来自 [Owncast](https://github.com/owncast/owncast)，但实现路线完全不同——Owncast 是
"RTMP 推流 → 服务器转码 → HLS 分发"，本项目是"浏览器采集 → 信令交换 → P2P 直连"。

## 特性

- **零依赖**：整个服务端就是一个 404 行的 `server.js`，只用 Node 标准库，`npm install` 都不用跑
- **浏览器开播**：摄像头 + 麦克风 + 屏幕共享，一条 WebAudio 混音总线把麦克风与系统声音合成单轨
- **低延迟**：WebRTC P2P，端到端通常在 1 秒以内（HLS 方案是 10–30 秒）
- **实时聊天**：SSE 推送，含历史记录、昵称配色、未读角标、限速防刷
- **服务器几乎不耗流量**：媒体流不经过服务器，只有信令与聊天走服务端
- **移动端可用**：单列布局，播放页自适应

## 架构

```
主播浏览器                          服务器(信令/状态/聊天)                  观众浏览器
   │                                      │                                │
   │──── POST /api/stream (开播) ────────▶│                                │
   │◀─── SSE  /api/events ───────────────▶│◀──── SSE /api/events ──────────│
   │                                      │                                │
   │──── POST /api/signal (offer) ───────▶│──── signal (offer) ───────────▶│
   │◀─── signal (answer) ─────────────────│◀─── POST /api/signal (answer) ──│
   │                                      │                                │
   │══════════ WebRTC 音视频直连（不经服务器）══════════════════════════════│
```

- 信令用 **SSE + POST** 而不是 WebSocket：反向代理兼容性更好，断线浏览器自动重连
- 每个观众一条独立的 `RTCPeerConnection`，主播端逐连接调码率
- 服务端状态全在内存：`clients` / `chatLog` / `stream`，进程重启即清空

## 快速开始

```bash
node server.js          # 默认 3000 端口
PORT=8080 node server.js
```

- 开播页：`http://localhost:3000/studio`
- 观看页：`http://localhost:3000/`

浏览器要求：摄像头/麦克风采集需要 HTTPS 或 `localhost`（`getUserMedia` 的安全上下文限制）。
屏幕共享的系统声音只有 Chrome / Edge 支持，且共享"标签页"时才会带上音频。

## 目录结构

```
server.js           # 全部服务端逻辑：静态文件 + SSE 信令 + 聊天 + 房间状态
public/
  index.html        # 观看页
  studio.html       # 开播控制台
  viewer.js         # 播放器 + 信令客户端 + 聊天
  studio.js         # 采集、混音、逐观众建连、设备切换
  styles.css        # 全部样式
```

## 已知限制

| 限制 | 原因 | 影响 |
|---|---|---|
| 约 150 人同时在线 | 托管层单实例并发长连接配额 | 超过后新连接超时 |
| 弱网/对称 NAT 下黑屏 | 没有 TURN 中继 | 部分企业网络无法观看 |
| 无回看、无录制 | 没有落盘 | 直播结束即消失 |
| 重启丢状态 | 全内存实现 | 主播需保持页面打开 |
| 主播上行 = 观众数 × 码率 | P2P 每个观众单独一份 | 家用宽带约 10 人上限 |

前两项的解决路径：加 TURN（coturn）解决 NAT 穿透；要突破人数上限需要换成 SFU
（mediasoup / LiveKit），由服务器分发而不是主播逐份推。

## License

MIT
