#!/usr/bin/env bash
set -Eeuo pipefail

# LUMA Live 一键部署 coturn（Ubuntu / Debian）
#
# 安装：sudo bash scripts/setup-turn.sh [TURN 主机名或公网 IP]
# 自检：bash scripts/setup-turn.sh --check      （不需要 root，只读检查）

TURN_SECRET_FILE="/etc/luma-live/turn-secret"
TURN_CONF="/etc/turnserver.conf"
LUMA_ENV="/etc/luma-live/turn.env"

MODE="install"
POSITIONAL=()
for arg in "$@"; do
  case "${arg}" in
    --check) MODE="check" ;;
    -h|--help)
      sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) POSITIONAL+=("${arg}") ;;
  esac
done

if [[ "${MODE}" == "check" ]]; then
  ok=0; warn=0; fail=0
  line() { printf '%-8s %s\n' "$1" "$2"; }
  pass() { line "[OK]" "$1"; ok=$((ok + 1)); }
  soft() { line "[WARN]" "$1"; warn=$((warn + 1)); }
  bad()  { line "[FAIL]" "$1"; fail=$((fail + 1)); }

  echo "LUMA Live · TURN 自检"
  echo

  if systemctl is-active --quiet coturn 2>/dev/null; then
    pass "coturn 服务运行中"
  else
    bad "coturn 服务未运行（systemctl status coturn）"
  fi

  if [[ -s "${TURN_CONF}" ]]; then
    pass "配置文件存在 ${TURN_CONF}"
    PORT="$(grep -E '^listening-port=' "${TURN_CONF}" | head -1 | cut -d= -f2)"
    PORT="${PORT:-3478}"
    if ss -H -lun 2>/dev/null | grep -q ":${PORT}\b"; then
      pass "UDP ${PORT} 正在监听"
    else
      bad "UDP ${PORT} 没有监听"
    fi
    if ss -H -ltn 2>/dev/null | grep -q ":${PORT}\b"; then
      pass "TCP ${PORT} 正在监听"
    else
      bad "TCP ${PORT} 没有监听"
    fi
    if grep -qE '^min-port=' "${TURN_CONF}" && grep -qE '^max-port=' "${TURN_CONF}"; then
      pass "中继端口段 $(grep -E '^min-port=' "${TURN_CONF}" | cut -d= -f2)-$(grep -E '^max-port=' "${TURN_CONF}" | cut -d= -f2)"
    else
      soft "未配置 min-port / max-port，中继可能占用随机高位端口"
    fi
    if grep -q '^use-auth-secret' "${TURN_CONF}"; then
      pass "已启用 REST 临时凭证"
    else
      bad "未启用 use-auth-secret，LUMA Live 下发的凭证会被拒绝"
    fi
  else
    bad "找不到 ${TURN_CONF}（还没跑过安装？）"
  fi

  if [[ -f "${TURN_SECRET_FILE}" ]]; then
    PERM="$(stat -c '%a' "${TURN_SECRET_FILE}" 2>/dev/null || echo '?')"
    if [[ "${PERM}" == "600" ]]; then
      pass "secret 文件权限 600"
    else
      soft "secret 文件权限为 ${PERM}，建议 chmod 600"
    fi
  else
    bad "找不到 ${TURN_SECRET_FILE}"
  fi

  if [[ -f "${LUMA_ENV}" ]]; then
    pass "LUMA 环境文件存在 ${LUMA_ENV}"
    if grep -q '^TURN_LINES=' "${LUMA_ENV}"; then
      pass "TURN_LINES 已写入"
    else
      bad "${LUMA_ENV} 里没有 TURN_LINES"
    fi
    if [[ -f /etc/luma-live.env ]] && ! grep -q 'TURN_LINES' /etc/luma-live.env 2>/dev/null; then
      soft "服务读的是 /etc/luma-live.env，记得把 TURN_LINES 也放进去"
    fi
  else
    soft "没有 ${LUMA_ENV}（如果你是用别的变量注入 TURN_LINES，可忽略）"
  fi

  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    for rule in "${PORT:-3478}/udp" "${PORT:-3478}/tcp" "5349/tcp"; do
      if ufw status 2>/dev/null | grep -q "${rule}"; then
        pass "ufw 放行 ${rule}"
      else
        soft "ufw 未放行 ${rule}"
      fi
    done
    if ufw status 2>/dev/null | grep -q '49152:65535/udp'; then
      pass "ufw 放行中继端口段"
    else
      soft "ufw 未放行 49152:65535/udp"
    fi
  else
    soft "未启用 ufw（若用云安全组，请自行确认放行 TCP/UDP ${PORT:-3478} 与 UDP 49152-65535）"
  fi

  PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [[ -n "${PUBLIC_IP}" ]]; then
    pass "公网出口 IP ${PUBLIC_IP}"
    SERVER_NAME="$(grep -E '^server-name=' "${TURN_CONF}" 2>/dev/null | head -1 | cut -d= -f2)"
    if [[ -n "${SERVER_NAME}" && "${SERVER_NAME}" != "${PUBLIC_IP}" && "${SERVER_NAME}" =~ ^[0-9.]+$ ]]; then
      soft "server-name 是 ${SERVER_NAME}，与本机出口 ${PUBLIC_IP} 不一致（多网卡/多出口时属正常）"
    fi
  else
    soft "取不到公网 IP（离线或被限制），跳过比对"
  fi

  if [[ -f /etc/luma-live.env && "${EUID}" -eq 0 ]]; then
    if grep -q '^TURN_LINES=' /etc/luma-live.env 2>/dev/null; then
      pass "LUMA Live 服务环境已包含 TURN_LINES"
    else
      soft "LUMA Live 服务环境没有 TURN_LINES，开播会失败"
    fi
  fi

  echo
  echo "结果：${ok} 项通过，${warn} 项提醒，${fail} 项失败"
  [[ "${fail}" -eq 0 ]] || exit 1
  echo "云厂商安全组脚本无法检查，请自行确认 TCP/UDP 3478 与 UDP 49152-65535 已放行。"
  exit 0
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "安装需要 root：sudo bash scripts/setup-turn.sh [公网 IP 或域名]" >&2
  echo "只想自检可以不带 sudo：bash scripts/setup-turn.sh --check" >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "当前脚本只支持 Debian / Ubuntu（需要 apt-get）。" >&2
  exit 1
fi

TURN_HOST="${POSITIONAL[0]:-}"
if [[ -z "${TURN_HOST}" ]]; then
  read -r -p "请输入 TURN 服务器公网 IP 或域名：" TURN_HOST
fi
if [[ -z "${TURN_HOST}" || "${TURN_HOST}" == *"|"* || "${TURN_HOST}" == *" "* ]]; then
  echo "TURN 主机不能为空，且不能包含空格或 |。" >&2
  exit 1
fi

TURN_REALM="${TURN_REALM:-luma-live}"
TURN_PORT="${TURN_PORT:-3478}"
TURN_TITLE="${TURN_TITLE:-主线路}"

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y coturn openssl

install -d -m 0750 /etc/luma-live
if [[ -s "${TURN_SECRET_FILE}" ]]; then
  TURN_SECRET="$(cat "${TURN_SECRET_FILE}")"
else
  TURN_SECRET="$(openssl rand -hex 32)"
  printf '%s\n' "${TURN_SECRET}" > "${TURN_SECRET_FILE}"
  chmod 0600 "${TURN_SECRET_FILE}"
fi

cat > "${TURN_CONF}" <<EOF
# Generated by LUMA Live setup-turn.sh
listening-port=${TURN_PORT}
tls-listening-port=5349
listening-ip=0.0.0.0
relay-ip=0.0.0.0
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=${TURN_SECRET}
realm=${TURN_REALM}
server-name=${TURN_HOST}
no-multicast-peers
no-cli
no-loopback-peers
stale-nonce=600
min-port=49152
max-port=65535
EOF
chmod 0640 "${TURN_CONF}"

cat > "${LUMA_ENV}" <<EOF
# Source this file when starting LUMA Live.
# TURN_LINES format: id|host|port|secret|title
TURN_LINES="main|${TURN_HOST}|${TURN_PORT}|${TURN_SECRET}|${TURN_TITLE}"
TURN_DEFAULT="main"
EOF
chmod 0640 "${LUMA_ENV}"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow "${TURN_PORT}/tcp" >/dev/null
  ufw allow "${TURN_PORT}/udp" >/dev/null
  ufw allow 5349/tcp >/dev/null
  ufw allow 5349/udp >/dev/null
  ufw allow 49152:65535/udp >/dev/null
fi

systemctl enable --now coturn
systemctl restart coturn
if ! systemctl is-active --quiet coturn; then
  echo "coturn 启动失败，请查看：journalctl -u coturn -n 80 --no-pager" >&2
  exit 1
fi

echo
echo "TURN 已部署并启动。"
echo "配置文件：${TURN_CONF}"
echo "LUMA 配置：${LUMA_ENV}"
echo
echo "在 LUMA Live 启动前执行："
echo "  set -a; source ${LUMA_ENV}; set +a"
echo "然后启动："
echo "  node server.js"
echo
echo "请确认云厂商安全组已放行 TCP/UDP ${TURN_PORT}、TCP/UDP 5349，以及 UDP 49152-65535。"
echo "TURN secret 已保存到 ${TURN_SECRET_FILE}，请勿提交到 Git。"
