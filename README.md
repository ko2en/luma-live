<div align="center">

# LUMA Live

**浏览器互连的直播间 · 打开一个网页就能开播**

不需要 OBS · 不需要 RTMP · 不需要转码服务器

<br>

![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=nodedotjs&logoColor=white)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![WebRTC](https://img.shields.io/badge/WebRTC-P2P-7C3AED?logo=webrtc&logoColor=white)
![latency](https://img.shields.io/badge/latency-%3C1s-06B6D4)
![code](https://img.shields.io/badge/server.js-544%20lines-2F363D)
![license](https://img.shields.io/badge/license-MIT-blue)

<br>

[30 秒上手](#30-秒上手) · [鉴权与参数](#开播鉴权与运维参数) · [TURN 中继](#turn-中继) · [工作原理](#工作原理) · [安装与部署](#安装与部署) · [已知限制](#已知限制)

</div>

## 30 秒上手

三种方式，挑一种。**观众不需要做任何事**——你把地址发给他就行。

### ① Windows：双击就开播

1. 点仓库右上角绿色 **Code → Download ZIP**
2. 解压到 `C:\luma-live`（不要在压缩包里直接双击）
3. 双击 **`start.bat`**

脚本会自动检查 Node.js——没装就帮你打开下载页，装好了就启动服务并自动打开开播台。仓库已经带了这个文件，不用写任何命令。

### ② macOS / Linux / Docker：一条命令

```bash
# 原生运行（需要 Node 18+）
git clone https://github.com/ko2en/luma-live.git && cd luma-live && ./start.sh

# 或者 Docker（连 Node 都不用装）
git clone https://github.com/ko2en/luma-live.git && cd luma-live && docker compose up -d
```

Windows 上装了 Docker 也一样适用，`docker compose up -d` 然后访问 `http://localhost:3000`。

### ③ 云端一键部署：点一下就有公网地址

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ko2en/luma-live)

点上面的按钮，用 GitHub 账号登录，确认后几分钟内给你一个 `https://xxx.onrender.com` 地址。**HTTPS 自动配好**，所以开播端点开就能用摄像头，不用自己折腾证书。免费额度足够个人直播（闲置一段时间实例会休眠，访问一下会自动唤醒）。

部署过程中它会要你填一个 `STREAM_KEY`——**这是开播口令，随便设一个自己能记住的**，开播时输入一次即可。留空就等于谁打开 `/studio` 都能抢你的麦。

其他支持 Node 的平台（Railway / Koyeb / Zeabur / Fly.io）同理：仓库根目录有 `Dockerfile` 和 `render.yaml`，构建命令留空、启动命令填 `node server.js` 即可。

> 无论是哪种方式，开播都要用 `http://localhost:3000/studio`（或平台给的 https 地址）。用 `IP:3000` 打开会拿不到摄像头——这是浏览器强制的安全策略，详见[安装与部署](#安装与部署)。

> **公网部署请先设开播口令**：`STREAM_KEY=你的口令 node server.js`。不设的话，任何打开 `/studio` 的人都能抢占主播位置、把你的直播顶掉。详见[开播鉴权与运维参数](#开播鉴权与运维参数)。

## 开播鉴权与运维参数

不设口令时，`/studio` 是裸奔的——谁打开都能开播。这在你自己电脑上无所谓，放到公网就必须补上。

```bash
STREAM_KEY=你的口令 node server.js
```

设置之后：

- 开播页会多出一个「开播口令」输入框，输对才会建立开播通道；
- 口令错时服务端直接返回 401，开播页不会反复撞接口；
- 口令存在浏览器本地（`localStorage`），下次打开自动带出，**不会**出现在分享链接里；
- 观众端完全不受影响，不需要口令。

口令比较用的是定长比较（`crypto.timingSafeEqual`），失败与成功耗时一致，不会被逐字节试探。

### 口令通道硬化

- **口令只走 POST body**。`/api/auth` 只接受 `POST`，用 `GET` 打过去返回 `405`（带 `Allow: POST`）——这样口令不会出现在反向代理的 URL 访问日志、浏览器历史和 Referer 里。
- **失败 5 次锁 60 秒**。`/api/auth`、开播端的 SSE 连接、`/api/stream` 三处共用同一份计数，按来源 IP 累计；锁定期间即使口令正确也返回 `429`，并带 `Retry-After`。开播页会显示「N 秒后重试」并自动等这么久再连，不会一直撞墙。
- **来源 IP 的判定**。默认只认 TCP 连接的真实地址；跑在 Caddy / Nginx / 云平台反代后面时，所有请求的来源都是代理本身，需要设 `TRUST_PROXY=1` 才会读 `X-Forwarded-For` 的第一段。

> 已知不足：`EventSource` 不能带 body，所以 host 的 SSE 连接仍把口令放在 query 里（`/api/events?role=host&key=...`），这部分会进反代日志。代码里留了 TODO，后续改成「`/api/auth` 换短期 token → SSE 带 token」即可彻底去掉。

运维参数：

| 变量 | 默认 | 作用 |
|---|---|---|
| `STREAM_KEY` | 空（不鉴权） | 开播口令。公网部署务必设置 |
| `HOST_GRACE_MS` | `10000` | 主播信令断线后的宽限期。期间不结束直播，重连回来继续播；设 `0` 表示立刻结束 |
| `CHAT_MIN_INTERVAL` | `350` | 同一连接的聊天最小间隔（毫秒） |
| `AUTH_MAX_FAILS` | `5` | 同一 IP 连续失败多少次后锁定 |
| `AUTH_LOCK_MS` | `60000` | 锁定多久（毫秒） |
| `TRUST_PROXY` | 未设 | 设 `1` 表示从 `X-Forwarded-For` 取来源 IP（在反向代理后面才需要） |

另外有几条硬规则写死在服务端，不靠前端自觉：

- **信令只允许 host ↔ viewer 两个方向**。观众之间互发直接被拒（403），伪造发信人也会被拒——`from` 由服务端按真实在线连接覆写，不看请求体。
- **聊天角色由连接决定**。自称 `role: "host"` 但没开播通道的，只会被当作观众。
- **聊天限速按连接算**，换昵称绕不过去；限速表有上限，连接断开即回收。

## TURN 中继

**可选，但公网部署强烈建议。** 不开 TURN 也能用，但有一类观众会永远黑屏：**公司网络、校园网、部分手机热点**在中间做对称 NAT，P2P 打洞打不通，两端都拿不到对方的地址。这不是 bug，是 P2P 架构的固有缺口，唯一解法是让流量经一台中继服务器转发。

配好之后：

- 能直连的观众**仍然直连**，一个字节都不多花；
- 只有打不通的那部分走中继，代价是吃服务器带宽（每人约 0.6–1.2 Mbps）；
- 走中继的观众会被自动压到 **mid 档（1.2 Mbps 封顶）**，主播状态栏显示「N 路中继」，让你随时知道服务器上压了多少流量。

### 1. 四个环境变量

| 变量 | 例子 | 说明 |
|---|---|---|
| `TURN_HOST` | `turn.example.com` | 不设就完全走原来的 STUN 直连，行为与以前一致 |
| `TURN_PORT` | `3478` | UDP/TCP 端口，同时兼作 STUN |
| `TURN_TLS_PORT` | `5349` | `turns:` 端口；设 `0` 可关掉 TLS 通道 |
| `TURN_STATIC_AUTH_SECRET` | 一串随机字符 | 与 coturn 的 `static-auth-secret` **必须完全一致** |

```bash
TURN_HOST=turn.example.com \
TURN_STATIC_AUTH_SECRET=$(openssl rand -hex 32) \
STREAM_KEY=你的口令 \
node server.js
```

凭证不是写死的：服务端按 coturn 的 REST API 规则现签，`username` 是「过期时间戳:luma」，`credential` 是 `base64(HMAC-SHA1(secret, username))`，有效期 6 小时，随 `welcome` 事件下发。前端不需要任何配置，`webrtc-internals` 里能直接看到服务端给的 `iceServers`。

### 2. 装 coturn

```bash
sudo apt update && sudo apt install -y coturn
```

配置文件 `/etc/turnserver.conf`：

```ini
listening-port=3478
tls-listening-port=5349
fingerprint

# REST API 凭证：secret 必须和 TURN_STATIC_AUTH_SECRET 一模一样
lt-cred-mech
use-auth-secret
static-auth-secret=把上面生成的那串粘过来
realm=turn.example.com

# 公网机器必须写公网 IP，否则发给观众的是内网地址，中继必然失败
external-ip=203.0.113.10

# 中继端口段：防火墙要整段放行，41 个端口够几十人同时中继
min-port=49160
max-port=49200

# TLS 证书：必须是真证书（Let's Encrypt），自签的浏览器直接拒绝 turns
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
no-tlsv1
no-tlsv1_1

# 禁止把中继当成进内网的跳板（这几个网段都是私网/保留段）
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff

no-cli
no-multicast-peers
```

`denied-peer-ip` 那几行不能省：不加的话，任何人都能借你的中继去探测你云上的内网（169.254 元数据服务、127.0.0.1 管理端口都在射程内）。

### 3. 开机自启

Debian/Ubuntu 的 coturn 装完默认是关闭的，要手动打开：

```bash
sudo sed -i 's/^#TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
sudo systemctl enable --now coturn
sudo systemctl status coturn --no-pager
```

### 4. 云防火墙要放的端口

| 端口 | 协议 | 用途 |
|---|---|---|
| 3478 | UDP **和** TCP | TURN / STUN 主端口 |
| 5349 | TCP（建议 UDP 也放） | `turns:` TLS 通道 |
| 49160–49200 | UDP | 中继端口段，必须整段放行 |

安全组里漏了最后一段是最常见的故障：握手能成，画面永远不来，因为真正的媒体包全被丢了。

### 5. 确认它真的生效了

1. 打开 `chrome://webrtc-internals`，看 `iceServers` 里有没有你配的 `turn:` / `turns:`，`username` 是不是 `时间戳:luma`；
2. 观众连上后看 `selected candidate pair`，`local-candidate` 的类型是 `relay` 就说明在走中继；
3. 主播端状态栏会显示「N 路中继」——这是最省事的判断方式，不用开调试面板。

> 注意：Render、Vercel 这类平台只给 HTTP/HTTPS，**没有 UDP**，coturn 放不上去。TURN 需要一台有公网 IP 的普通云主机（1 核 1G、按流量计费的最便宜那种就够）。


## 界面

![开播控制台](docs/studio.png)

## 这是什么

主播打开 `/studio`，点一下「开始直播」，摄像头画面立刻进直播间；观众打开链接就能看，还能实时聊天。

**音视频不经过服务器**——主播和每个观众之间直接建立 WebRTC 点对点连接。服务器只做三件事：转发信令、维护房间状态、广播聊天消息。所以一台 1 核 512MB 的小机器就能撑起一整场直播。

```
主播浏览器 ──────── WebRTC 音视频直连 ────────▶ 观众浏览器
     │                                              ▲
     │  信令 / 状态 / 聊天（KB 级，走服务器）          │
     └──────────────▶  server.js  ──────────────────┘
```

## 它适合你吗

先把丑话说在前面，省得你装完才发现不对：

| 你的场景 | 合不合适 |
|---|---|
| 和同事、朋友开个小直播，10 人以内 | ✅ **最合适**，一个文件夹搞定 |
| 想零成本、当天就能用 | ✅ 零依赖、零配置、零费用 |
| 内网 / 离线环境直播（没有公网） | ✅ 纯 P2P，只要两边网络能通 |
| 需要一个「低延迟监看」画面（导播、远程看片场） | ✅ 延迟通常 1 秒内 |
| 想替代 Zoom / 腾讯会议开会 | ⚠️ 没有多人宫格、没有会控、没有录制 |
| 要几百上千人同时看 | ❌ 换 SFU（mediasoup / LiveKit） |
| 要录播回看、要手机原生播放器能看 | ❌ 不支持 |

一句话：**它是「房间」，不是「平台」。** 如果你的需求是"点开就能播、发给几个人看、延迟要低、别花钱"，它就是为你做的。

## 和 Owncast 有什么区别

项目灵感来自 [Owncast](https://github.com/owncast/owncast)，但技术路线完全不同——它是一条"推流管线"，这是一条"电话总机"。

|  | Owncast | LUMA Live |
|---|---|---|
| 开播方式 | OBS 推 RTMP 到服务器 | **浏览器点按钮** |
| 媒体路径 | 服务器收流 → ffmpeg 转码 → HLS 分发 | **浏览器 ↔ 浏览器直连** |
| 延迟 | 10–30 秒（HLS） | **< 1 秒** |
| 服务器带宽 | 每个观众 1–3 Mbps | **接近 0** |
| 观众规模 | 看 CDN，轻松上千 | 约 150（受并发长连接限制） |
| 回看 / 录像 | 支持 | 不支持 |
| 播放端 | 任何播放器 / 手机 | 只能是浏览器 |

一句话：**Owncast 是能运营的直播平台，LUMA Live 是打开就能用的房间。**

## 工作原理

```mermaid
flowchart LR
  subgraph HOST["主播浏览器"]
    direction TB
    CAM["摄像头 / 麦克风"] --> MIX["WebAudio 混音总线"]
    SCR["屏幕共享 + 系统声音"] --> MIX
    MIX --> PC["RTCPeerConnection ×N"]
  end

  subgraph SRV["server.js · 单文件零依赖"]
    direction TB
    SIG["SSE 信令<br/>/api/events"]
    ROOM["房间状态<br/>/api/stream"]
    CHAT["聊天广播<br/>/api/chat"]
  end

  subgraph VIEW["观众浏览器 ×N"]
    direction TB
    RPC["RTCPeerConnection"]
    UI["播放器 + 聊天"]
  end

  PC -- "offer / answer / ICE" --> SIG
  SIG -- "转发给对应观众" --> RPC
  PC == "音视频 · 点对点" ==> RPC
  CHAT --> UI
  ROOM --> UI
```

## 六个值得一看的实现

**1. 用 SSE 而不是 WebSocket 做信令**
`GET /api/events` 是普通 HTTP 长连接，穿反向代理、企业网关、CDN 都不需要额外配置；断开后浏览器自动重连。配合 `POST /api/signal` 做单向投递，实现起来比 WebSocket 简单一个数量级。全服务端共用一个 20 秒心跳定时器，而不是每个连接一个。

**2. WebAudio 混音总线，把两路音频合成一条**
麦克风和屏幕共享通常各自带一条音轨。直接二选一会丢掉系统声音（播放视频时观众听不到），推两条轨又要处理协商。做法是在前端建一条混音总线：

```js
micSource → micGain ┐
                    ├→ masterGain → MediaStreamAudioDestination → 单条 program 音轨
screenSource → screenGain ┘
```

静音用 `gain` 渐变而不是 `stop()`，避免重新协商；直播中开停屏幕共享也能无感切换。

**3. 服务端扇出：把 O(N²) 压回 O(N)**
观众成批涌入时，每个新人触发一次全量状态广播，就是 O(N²)。改成 200ms 合并窗口 + 一次 `flush`，同时把广播改成预构造 frame 后直接遍历连接池。2000 个连接建立时间从 **42 秒降到 1.8 秒**，单条消息扇出中位数 **11ms**。

**4. 主播掉线不立刻判死**
家用网络闪断是常态。原来 host 的 SSE 一断，服务端马上广播 `stream-ended`，观众画面立刻黑掉——可实际上媒体是 P2P 直连，此刻主播的画面还在传。现在断线只清掉 `hostId`，启动一个 10 秒宽限定时器：期间重连回来（哪怕是新标签页、新 id）这场直播继续；超时才真正结束。观众端会看到「主播网络抖了一下，正在自动重连」而不是直接黑屏。

**5. 每个观众一份码率档位**
架构上主播对每个观众是一条独立 `RTCPeerConnection`，所以「按人调码率」几乎不要额外成本。观众每 3 秒从 `getStats()` 取自己的收包码率、丢包率、RTT，通过信令回报；主播据此把这一路的上限设成 2.5 / 1.2 / 0.6 Mbps：

```js
loss > 8% || rtt > 500ms  → 600 kbps  + degradationPreference: balanced
loss > 3% || rtt > 250ms  → 1200 kbps
否则                       → 2500 kbps + maintain-resolution
```

降档立即生效，升档要连续三次稳定才升，避免在边界来回抖。弱网观众不再拖累其他人，主播的上行也省下来。

**6. TURN 凭证现签，前端零配置**
中继要能用，又不能让 `static-auth-secret` 出现在前端代码里。做法是每次下发 `welcome` 时按 coturn 的 REST 规则现签一个临时凭证：

```js
const username = `${Math.floor(Date.now() / 1000) + 6 * 3600}:luma`;   // 6 小时后过期
const credential = createHmac('sha1', secret).update(username).digest('base64');
```

客户端收到就覆盖 ICE 配置——`welcome` 会因 `EventSource` 重连重复下发，所以这个动作必须是幂等的。反过来，观众端每 3 秒在同一次 `getStats()` 里把 `candidate-pair.localCandidateId` 关联回 `local-candidate`，看 `candidateType` 是不是 `relay`：

```js
候选对 → localCandidateId → local-candidate.candidateType === 'relay'
```

一旦确认走中继，这一路立刻压到 mid 档 1.2 Mbps——因为中继的流量是服务器在付钱，不该为了多 1000 kbps 清晰度把出口带宽烧穿。

## 安装与部署

先说清楚一件事：**观众什么都不用装**，打开浏览器就能看。整个项目只有一台机器需要准备，就是运行 `server.js` 的那台——它负责信令、房间状态和聊天。音视频是浏览器之间直连的，不经过它。

这台机器有两种选择：

| | 你自己的 Windows 电脑 | 一台云服务器 |
|---|---|---|
| 谁能看 | 同一 Wi-Fi 的人；外网要加个穿透隧道 | 任何人，凭链接 |
| 长期在线 | 关机/休眠就断，页面必须一直开着 | 7×24 常驻 |
| HTTPS | 本机开播可以，对外要额外处理 | 域名 + 自动证书，一次配好 |
| 花费 | 0 | 最低配约 ¥30/月 |
| 适合 | 自己、同事、朋友几个人 | 要发给一批人看 |

### 装到哪里

其实没有「安装」这一步——就是一个文件夹里的文件。不写注册表、不装驱动、不注册系统服务、不连数据库。删掉文件夹就等于卸载干净。

| 系统 | 建议位置 | 不要放 |
|---|---|---|
| Windows | `C:\luma-live` | 桌面、下载、`C:\Program Files`、中文或带空格的路径 |
| Linux | `/opt/luma-live` | `/root`、`/tmp` |

唯一的前置依赖是 **Node.js ≥ 18**。

> 想省事的话，这一节可以整段跳过：Windows 直接双击仓库里的 **`start.bat`**，macOS / Linux 执行 **`./start.sh`**，脚本会自己检查 Node、启动服务、打开浏览器。下面写的是想自己控制每一个步骤（或者要部署到服务器）时的做法。

### 方案 A：装在自己的 Windows 电脑上

1. **装 Node.js** —— 到 [nodejs.org](https://nodejs.org) 下载 LTS 的 `.msi`，一路下一步。装完打开 PowerShell 验证：`node -v`（应显示 v18 以上）
2. **放代码** —— 新建 `C:\luma-live`，把代码放进去：装了 git 就 `git clone https://github.com/ko2en/luma-live.git C:\luma-live`，没装就点仓库右上角 **Code → Download ZIP**，解压到 `C:\luma-live`
3. **启动** —— 双击 `C:\luma-live\start.bat`（它会自己开浏览器），或者在 PowerShell 里手动执行：

```powershell
cd C:\luma-live
node server.js
```

看到 `LUMA Live 已启动` 就成了，然后：

| 你要做的事 | 地址 |
|---|---|
| 开播 | `http://localhost:3000/studio` |
| 同一 Wi-Fi 的观众 | `http://<你的内网IP>:3000`（`ipconfig` 查 IPv4） |
| 不在同一网络的观众 | 见下面「内网穿透」 |

首次启动 Windows 防火墙会弹窗，勾**专用网络**并允许，否则局域网里别人连不进来。

**内网穿透**（不在同一 Wi-Fi 的人要看，又不想买服务器）：装 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)，在服务启动的同时另开一个窗口执行：

```powershell
cloudflared tunnel --url http://localhost:3000
```

它会打印一个临时的 `https://xxx.trycloudflare.com` 地址，直接发给别人就能看。顺带把 HTTPS 也解决了（下面会讲为什么需要它）。

### 方案 B：装到云服务器

最小配置就够：**1 核 1G**，Ubuntu 22.04 或 Debian 12。因为媒体流不走服务器，带宽只要够加载页面，3–5 Mbps 就行。

```bash
# 1. 装 Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

# 2. 代码放 /opt
sudo mkdir -p /opt/luma-live && sudo chown "$USER":"$USER" /opt/luma-live
git clone https://github.com/ko2en/luma-live.git /opt/luma-live

# 3. 试跑
cd /opt/luma-live && PORT=3000 node server.js
```

试通了再做成常驻服务，新建 `/etc/systemd/system/luma-live.service`：

```ini
[Unit]
Description=LUMA Live
After=network.target

[Service]
WorkingDirectory=/opt/luma-live
Environment=PORT=3000
ExecStart=/usr/bin/node server.js
Restart=always
User=你的用户名

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now luma-live
sudo systemctl status luma-live     # 看是否 active (running)
```

**配 HTTPS**：用 Caddy 最省事，证书自动申请续期。`/etc/caddy/Caddyfile`：

```
live.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

`flush_interval -1` 这行是关键——不写的话 SSE 会被缓冲，表现是页面能打开、聊天半天不动、开播后观众一直黑屏。

用 Nginx 的话，`location /` 里必须有这三行：

```nginx
proxy_http_version 1.1;
proxy_buffering off;          # 关掉缓冲，SSE 才能实时推送
proxy_read_timeout 3600s;     # 长连接别被默认 60s 掐断
```

最后：安全组/防火墙只放行 **80 和 443**，不要把 3000 端口暴露到公网。

### 五个最容易踩的坑

1. **用 `IP:3000` 打开 `/studio` 拿不到摄像头** —— 采集要求安全上下文（secure context），主播端必须是 `localhost` 或 `https://`。这是浏览器强制的，不是本项目的问题。
2. **反向代理忘了关缓冲** —— 页面正常但聊天不动、观众黑屏，八成是这行漏了。
3. **把 3000 直接暴露公网** —— 既没有 TLS 也没必要，统一经 80/443 转发。
4. **电脑休眠/关盖** —— 服务挂了直播就断。服务端状态全在内存，不落盘，重启即清空。
5. **以为人多了要加 CPU** —— 真正的瓶颈是主播的上行带宽和并发连接数，不是 CPU；1 核机器跑信令毫无压力。

> 补充：摄像头/麦克风采集要求**安全上下文**，`localhost` 或 HTTPS 都算；屏幕共享的**系统声音**只有 Chrome / Edge 支持，且共享「标签页」时才带音频。


观众打开后看到的是这样——左侧播放器，右侧实时聊天，手机浏览器自动切成单列：

![观众页](docs/viewer.png)

## 目录结构

```
server.js            静态文件 + SSE 信令 + 聊天 + 房间状态 + ICE 下发（698 行）
public/
  index.html         观众页
  studio.html        开播控制台
  viewer.js          播放器 + 信令客户端 + 聊天 + 链路回报 + 中继识别（683 行）
  studio.js          采集、混音、逐观众建连、码率分档（1296 行）
  styles.css         全部样式
scripts/
  test-api.js         服务端回归：鉴权 / 口令限速 / 信令方向 / 断线宽限 / 聊天限速 / ICE 下发
  test-studio-key.js  用真实浏览器验证口令流程（CDP 驱动）
  test-e2e.js         开播 → 观看 → 刷新重连 的端到端验证
  test-relay.js       把候选类型伪装成 relay，验证中继观众被压到 mid 档
docs/                README 用的截图
```

三个测试脚本都是零依赖的，`node scripts/test-api.js` 就能跑（会自动起一个带口令的临时服务，54 项断言）。

## 已知限制

这套架构用「省带宽」换掉了「兜底能力」，边界很清楚：

| 限制 | 原因 | 缓解方式 |
|---|---|---|
| 约 150 人同时在线 | 托管层单实例并发长连接配额 | 换更大的实例 / 前置 CDN |
| 对称 NAT 下黑屏 | P2P 打洞打不通 | **配 TURN**（见上一节），配好后自动降级为中继 |
| 主播上行 = 观众数 × 码率 | 每个观众一份独立编码 | 家用宽带约 10 人上限 |
| 中继吃服务器带宽 | 走 TURN 的观众流量过服务器 | 已自动压到 mid 档；中继人数在状态栏可见 |
| 无回看、无录制 | 不落盘 | 需要单独做录制链路 |
| 重启丢状态 | 全内存实现 | 主播需保持页面打开 |

打洞失败现在会明确告诉你「连不上主播的画面，换网络试试」，而不是让你盯着「正在接入画面…」等到放弃。真要兼容严格的企业网络，配 TURN 就行——但那是另一台机器、另一笔流量费。

要突破人数上限，必须换成 SFU（mediasoup / LiveKit）——由服务器分发而不是主播逐份推。这不是调参能解决的。

## 路线图

- [x] 开播鉴权（`STREAM_KEY`）+ 口令限速（5 次 / 60 秒）
- [x] 口令走 POST body，不再进反向代理访问日志
- [x] 信令方向校验 + 服务端覆写 `from`
- [x] 主播断线宽限期（`HOST_GRACE_MS`）
- [x] 按观众网络自适应码率（2.5 / 1.2 / 0.6 Mbps）
- [x] 打洞失败给出可读提示 + 半死连接自检
- [x] TURN 中继（coturn + REST 凭证，服务端下发 ICE 配置）
- [x] 中继观众识别 + 限码率
- [ ] SSE 用短期 token 取代 query 里的口令
- [ ] 分辨率分档（360p / 540p / 720p，而不只是码率）
- [ ] 录像与回看（MediaRecorder 落盘）
- [ ] 可选 SFU 模式，突破点对点人数上限

## License

[MIT](LICENSE)
