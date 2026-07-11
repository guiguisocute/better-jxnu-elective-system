#!/usr/bin/env bash
# 安装/更新 jxnu-admin 管理面板（幂等，可重复执行）。
# 在 VPS 上、仓库目录内运行：./deploy/install-admin.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/apps/jxnu-admin"
UNIT_DIR="$HOME/.config/systemd/user"

log() { echo "[install-admin] $*"; }

mkdir -p "$APP" "$UNIT_DIR"

# 1) 拷贝服务主体（每次都更新到仓库最新版）
install -m 0644 "$REPO/tools/admin_service.py" "$APP/admin_service.py"
log "已更新 $APP/admin_service.py"

# 2) 首次生成 admin.env（已存在则不动，保用户手改）
if [ ! -f "$APP/admin.env" ]; then
  if command -v openssl >/dev/null 2>&1; then
    PW="$(openssl rand -hex 16)"
  else
    PW="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
  fi
  umask 077  # 落盘即 600，消除「写完再 chmod」的权限窗口（install -m 显式给模式，不受影响）
  cat > "$APP/admin.env" <<EOF
# jxnu-admin 管理面板配置（由 install-admin.sh 生成；键说明见 deploy/admin.env.example）
ADMIN_BIND=127.0.0.1
ADMIN_PORT=8790
ADMIN_PASSWORD=$PW
REPO_DIR=$HOME/better-jxnu-elective-system
KKAP_ENV=$HOME/apps/jxnu-kkap/kkap.env
SYNC_ENV=$HOME/apps/jxnu-kkap/sync.env
LIVE_ENV=$HOME/apps/jxnu-live/live.env
SYNC_LOCK=$HOME/apps/jxnu-kkap/sync.lock
CF_ACCOUNT_ID=
CF_API_TOKEN=
CF_PAGES_PROJECT=jxnu-elective-plus
EOF
  chmod 600 "$APP/admin.env"
  log "已生成 $APP/admin.env（600 权限）"
  log "★ 随机管理密码：$PW ——请立刻保存；之后可编辑 admin.env 修改"
else
  log "$APP/admin.env 已存在，不改动"
fi

# 3) 安装 systemd user 单元并（重）启动
install -m 0644 "$REPO/deploy/jxnu-admin.service" "$UNIT_DIR/jxnu-admin.service"
systemctl --user daemon-reload
systemctl --user enable jxnu-admin.service
systemctl --user restart jxnu-admin.service
log "jxnu-admin.service 已 enable 并重启"

# 4) 自检（端口取 admin.env 里的 ADMIN_PORT，默认 8790）
PORT="$(grep -E '^ADMIN_PORT=' "$APP/admin.env" | tail -n1 | cut -d= -f2 || true)"
PORT="${PORT:-8790}"
sleep 1
if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null; then
  log "[OK] 面板已启动：本机 http://127.0.0.1:$PORT"
  log "访问方式（本地机器上）：ssh -L $PORT:127.0.0.1:$PORT <VPS别名>（别名在本地 ~/.ssh/config 配置）"
  log "然后浏览器打开 http://127.0.0.1:$PORT"
else
  log "[WARN] 自检失败，查看日志：journalctl --user -u jxnu-admin -n 50 --no-pager"
  exit 1
fi
