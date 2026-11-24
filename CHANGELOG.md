# 更新日志

## 1.3.1 — 2026-11-24

### 变更

- **发送帧率 30 → 60 fps**，码率上限同步从 1.2 Mbps 提到 2.8 Mbps。
  只提帧率不提码率会让画面更糊（帧多了但每帧分到的比特更少），所以两者一起改。
- 摄像头、屏幕共享、`maxFramerate` 与状态栏目标帧率统一由 `VIDEO_TARGET_FPS` 控制，
  以后改帧率只需要动这一个常量。
- 画质健康判定不再写死 26/29 fps，改为按目标帧率换算（低于 85% 记为掉帧）。

### 注意

- 60fps 的上行开销约为 30fps 的两倍：TURN 中继带宽与主播上行都要留出余量。
  观众多、或主播上行吃紧时，可以在 `public/studio.js` 把 `VIDEO_TARGET_FPS` 调回 30、
  `FIXED_BITRATE` 调回 1200000。
- 摄像头设备本身不支持 60fps 时，浏览器会给出它能给的最高帧率，不会强行插帧。

## 1.3.0 — 2026-11-24

这一版的主题是「账号与部署」：加了登录体系、把开播口令从 URL 里挪走、密码换算法、
后端拆成模块，部署脚本也按机器拓扑拆成两种。

### 新增

- **账号登录**：`AUTH_USERS` 作为首次种子写入 `data/users.json`，之后以文件为准；
  未登录只能看到登录页，观看与开播都需要账号。支持自助改账号、改密码、上传头像。
- **网页内连接诊断**：开播台可以跑一次 relay-only 的候选收集，逐项列出
  凭证 / 线路 / 中继候选 / UDP / TCP / 握手耗时，失败时给出下一步建议。
- **摄像头热切换**：控制台可选摄像头，切换时 `replaceTrack` 复用现有连接，观众不断流。
- **部署脚本**：`scripts/deploy.sh` 支持 `all-in-one`（同机）、`turn`（只装 TURN）、
  `app`（只装应用）、`status`（自检）四种模式，幂等。
- **运维接口**：`/healthz`（存活）、`/readyz`（数据目录、账号模式、TURN 线路）、`npm run doctor`。
- **部署模板**：`deploy/Caddyfile.example`、`deploy/nginx.conf.example`、`deploy/luma-live.service`。

### 变更

- **密码存储改为 scrypt**：`scrypt:<N>:<r>:<p>:<salt>:<hash>`。旧的 `sha256:` 与明文记录
  在一次成功登录后自动升级，用户不需要改密码。`AUTH_USERS` 里的明文种子在首次落盘时即哈希。
- **后端拆分**：`server.js` 从约 1600 行降到约 900 行，其余按职责拆到 `src/`：
  `config` / `http` / `live` / `users` / `password` / `turn` / `util`。
- **所有环境变量集中到 `src/config.js`**，配置对象与 TURN 线路在启动后冻结。
- **TURN_DEFAULT 真正生效**：按 id 选中线路，找不到才退回第一条（以前固定用第一条）。
- **安全响应头**：CSP、Permissions-Policy（限定摄像头/麦克风/屏幕采集）、COOP/CORP、
  X-Frame-Options；仅 HTTPS 时发 HSTS。
- **写接口增加 Origin/Referer 同源校验**，与 `SameSite=Strict` 形成两层。
- **优雅退出**：收到 SIGTERM/SIGINT 先广播 `server-shutdown`，再关 SSE 与房间状态。

### 破坏性变更 / 升级注意

1. **`/api/events?key=...` 不再接受**。开播端必须先 `POST /api/sse-ticket` 换一张
   60 秒一次性票据，再把 `ticket` 拼进 query。浏览器缓存了旧 `studio.js` 的会看到
   「未连接」，刷新页面即可。
2. **密码摘要格式变化会让旧 cookie 失效**：cookie 指纹基于凭证摘要，账号升级到 scrypt 后，
   该账号在其它设备上需要重新登录一次（改密码本来也是这个行为）。
3. **部署脚本会移除 `AUTH_USERS`**：首次启动生成 `data/users.json` 后，脚本会把
   `AUTH_USERS` 从 `/etc/luma-live.env` 删掉，避免环境文件长期保留种子。
   如果你删掉 `data/users.json` 又重启，鉴权会退回公开模式 —— 记得重新设置账号。
4. **单实例限制**：账号库、房间状态、SSE 票据都在进程内存里，不要用 cluster 或多副本部署。

### 面向运维

- 升级方式：`git pull` → `sudo bash scripts/deploy.sh app` （代码会覆盖，`data/` 保留）
- 自检：`bash scripts/deploy.sh status`、`bash scripts/setup-turn.sh --check`
- 已知边界：主播逐观众发送媒体，上行带宽随观众数线性增长；中继带宽单独计算。

## 1.2.0 及更早

1.2.0 之前没有维护独立的更新日志，历史变更见 git 提交记录。
