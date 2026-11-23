#!/usr/bin/env bash
set -Eeuo pipefail

# LUMA Live 一键部署（Ubuntu / Debian）
#
# 两种拓扑，按机器分：
#   1) 同一台机器跑 LUMA + TURN
#        sudo bash scripts/deploy.sh all-in-one <公网IP或域名>
#   2) 两台机器分别跑
#        TURN 机：sudo bash scripts/deploy.sh turn <公网IP或域名>
#                 → 输出一行 TURN_LINES，复制到应用机
#        应用机：sudo bash scripts/deploy.sh app "<TURN_LINES>"
#
# 自检（任意机器，不需要 root）：
#        bash scripts/deploy.sh status
#
# 约定：
#   - 应用目录 /opt/luma-live，账号库 /opt/luma-live/data
#   - 环境变量 /etc/luma-live.env（600），不要提交到 Git
#   - 服务由 systemd 托管：systemctl status luma-live

APP_DIR="/opt/luma-live"
ENV_FILE="/etc/luma-live.env"
APP_USER="luma"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

need_root() {
  [[ "${EUID}" -eq 0 ]] || die "需要 root：请用 sudo 运行"
}

need_apt() {
  command -v apt-get >/dev/null 2>&1 || die "当前脚本只支持 Debian / Ubuntu（需要 apt-get）"
}

# 有 openssl 用 openssl，没有就用 node 兜底，避免为了一个随机串再装包
rand_hex() {
  local bytes="${1:-32}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "${bytes}"
  elif command -v node >/dev/null 2>&1; then
    node -e "console.log(require('crypto').randomBytes(${bytes}).toString('hex'))"
  else
    die "生成随机密钥需要 openssl 或 node"
  fi
}

rand_pass() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 18 | tr -d '/+=' | cut -c1-16
  else
    node -e "console.log(require('crypto').randomBytes(12).toString('base64url').slice(0,16))"
  fi
}

# ---------------------------------------------------------------- 公共

ensure_node() {
  local major=0
  if command -v node >/dev/null 2>&1; then
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  fi
  if [[ "${major}" -ge 18 ]]; then
    ok "Node.js $(node -v)"
    return
  fi

  say "安装 Node.js 20（当前 $( [[ ${major} -gt 0 ]] && node -v || echo '未安装' )）"
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "${major}" -ge 18 ]] || die "Node.js 安装后版本仍低于 18"
  ok "Node.js $(node -v)"
}

ensure_user() {
  if id "${APP_USER}" >/dev/null 2>&1; then
    ok "运行账号 ${APP_USER} 已存在"
  else
    useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
    ok "已创建系统账号 ${APP_USER}"
  fi
}

copy_app() {
  [[ -f "${REPO_DIR}/server.js" ]] || die "请在仓库目录内运行（找不到 server.js）"
  install -d -m 0755 "${APP_DIR}"
  # 只同步运行需要的文件，别把 data/、.git/、备份一起搬过去
  for item in server.js package.json src public scripts start.sh; do
    [[ -e "${REPO_DIR}/${item}" ]] || continue
    rm -rf "${APP_DIR:?}/${item}"
    cp -a "${REPO_DIR}/${item}" "${APP_DIR}/${item}"
  done
  install -d -m 0750 -o "${APP_USER}" -g "${APP_USER}" "${APP_DIR}/data"
  chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
  ok "代码已同步到 ${APP_DIR}"
}

ensure_secret() {
  if [[ -f "${ENV_FILE}" ]] && grep -q '^AUTH_SECRET=' "${ENV_FILE}"; then
    ok "沿用已有 AUTH_SECRET"
    return
  fi
  install -d -m 0750 /etc/luma-live
  printf 'AUTH_SECRET=%s\n' "$(rand_hex 32)" >> "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  ok "已生成 AUTH_SECRET"
}

ensure_admin() {
  if [[ -f "${ENV_FILE}" ]] && grep -q '^AUTH_USERS=' "${ENV_FILE}"; then
    ok "AUTH_USERS 已存在，保持不动"
    return
  fi
  if [[ -s "${APP_DIR}/data/users.json" ]]; then
    ok "已有 data/users.json，跳过初始账号"
    return
  fi

  local user pass
  read -r -p "  管理员账号名 [admin]: " user || true
  user="${user:-admin}"
  while :; do
    read -r -s -p "  管理员密码（留空则随机生成）: " pass || true
    echo
    if [[ -z "${pass}" ]]; then
      pass="$(rand_pass)"
      printf '  已生成密码：\033[1m%s\033[0m（请立刻保存）\n' "${pass}"
      break
    fi
    [[ ${#pass} -ge 8 ]] && break
    warn "至少 8 位"
  done
  printf 'AUTH_USERS=%s:%s\n' "${user}" "${pass}" >> "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  ok "已写入初始账号 ${user}"
}

set_env_line() {
  local key="$1" value="$2"
  touch "${ENV_FILE}"
  if grep -q "^${key}=" "${ENV_FILE}"; then
    # 用 | 作分隔，避免值里的 / 干扰
    sed -i "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
  fi
  chmod 600 "${ENV_FILE}"
}

install_unit() {
  local unit_src="${REPO_DIR}/deploy/luma-live.service"
  [[ -f "${unit_src}" ]] || die "缺少 deploy/luma-live.service"
  install -m 0644 "${unit_src}" /etc/systemd/system/luma-live.service
  systemctl daemon-reload
  systemctl enable luma-live >/dev/null 2>&1 || true
  systemctl restart luma-live
  sleep 2
  systemctl is-active --quiet luma-live || {
    journalctl -u luma-live -n 30 --no-pager || true
    die "luma-live 启动失败"
  }
  ok "luma-live 已启动"
}

print_turn_lines() {
  local host="$1" secret="$2" port="${3:-3478}"
  printf '\nTURN_LINES="main|%s|%s|%s|主线路"\n' "${host}" "${port}" "${secret}"
}

do_turn() {
  local host="$1"
  need_apt
  say "安装 coturn（${host}）"
  bash "${REPO_DIR}/scripts/setup-turn.sh" "${host}"
  local secret
  secret="$(cat /etc/luma-live/turn-secret)"
  ok "coturn 就绪"
  say "把这行填到应用机的 /etc/luma-live.env："
  print_turn_lines "${host}" "${secret}"
  echo
  echo "  别忘了云安全组放行：TCP/UDP 3478、TCP/UDP 5349、UDP 49152-65535"
}

do_app() {
  local turn_lines="${1:-}"
  need_apt
  say "安装 LUMA Live"
  ensure_node
  ensure_user

  install -d -m 0750 /etc/luma-live
  touch "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"

  ensure_secret
  ensure_admin

  set_env_line PORT 3000
  set_env_line COOKIE_SECURE 0
  set_env_line TRUST_PROXY 1
  if [[ -n "${turn_lines}" ]]; then
    set_env_line TURN_LINES "\"${turn_lines}\""
    ok "已写入 TURN_LINES"
  elif grep -q '^TURN_LINES=' "${ENV_FILE}"; then
    ok "沿用已有 TURN_LINES"
  else
    warn "没有 TURN_LINES：开播会因为没有中继而失败"
    warn "TURN 机上跑 deploy.sh turn 会打印这一行，回头写进 ${ENV_FILE} 即可"
  fi

  copy_app
  install_unit

  say "部署完成"
  echo "  登录页   http://<本机IP>:3000/login"
  echo "  账号密码 见 ${ENV_FILE} 里的 AUTH_USERS（仅首次启动作为种子）"
  echo "  账号库   ${APP_DIR}/data/users.json"
  echo
  echo "  接下来建议："
  echo "   1) 前面挂 Caddy / nginx（模板在 deploy/），并把 COOKIE_SECURE 改成 1"
  echo "   2) 跑一次 bash scripts/deploy.sh status 自检"
}

do_all_in_one() {
  local host="$1"
  do_turn "${host}"
  local secret
  secret="$(cat /etc/luma-live/turn-secret)"
  do_app "main|${host}|3478|${secret}|主线路"
  say "全部就绪"
  echo "  TURN 与 LUMA 同机：请确认安全组放行 3000（或走反代 443）以及 TURN 的 UDP 端口段"
}

do_status() {
  say "LUMA Live 自检"
  if systemctl is-active --quiet luma-live 2>/dev/null; then
    ok "luma-live 运行中"
  else
    warn "luma-live 未运行（本机可能只是 TURN 机）"
  fi

  if command -v curl >/dev/null 2>&1; then
    local body
    body="$(curl -fsS --max-time 3 http://127.0.0.1:3000/readyz 2>/dev/null || true)"
    if [[ -n "${body}" ]]; then
      if printf '%s' "${body}" | grep -q '"ok":true'; then ok "readyz 正常：${body}"; else die "readyz 异常：${body}"; fi
    else
      warn "取不到 /readyz（没装应用或端口不是 3000）"
    fi
  fi

  if systemctl list-unit-files 2>/dev/null | grep -q '^coturn.service'; then
    echo
    echo "TURN 自检："
    bash "$(dirname "${BASH_SOURCE[0]}")/setup-turn.sh" --check || true
  fi
}

usage() {
  sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

main() {
  local mode="${1:-}"
  case "${mode}" in
    all-in-one)
      need_root
      [[ -n "${2:-}" ]] || die "用法：deploy.sh all-in-one <公网IP或域名>"
      do_all_in_one "$2"
      ;;
    turn)
      need_root
      [[ -n "${2:-}" ]] || die "用法：deploy.sh turn <公网IP或域名>"
      do_turn "$2"
      ;;
    app)
      need_root
      do_app "${2:-}"
      ;;
    status|check)
      do_status
      ;;
    -h|--help|help|"")
      usage
      ;;
    *)
      die "未知模式：${mode}（可用：all-in-one / turn / app / status）"
      ;;
  esac
}

main "$@"
