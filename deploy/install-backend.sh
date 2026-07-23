#!/usr/bin/env bash
# 安装/升级统一 Go 后端。可传入已交叉编译的 Linux 二进制；未传时尝试在 VPS 用 go build。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
APP_DIR="$HOME/apps/jxnu-backend"
UNIT_DIR="$HOME/.config/systemd/user"
ENV_FILE="$APP_DIR/backend.env"
CONFIG_FILE="$APP_DIR/config.json"
BINARY_SOURCE="${1:-}"

mkdir -p "$APP_DIR" "$UNIT_DIR"

if systemctl --user is-active --quiet jxnu-sync.service 2>/dev/null; then
  echo "jxnu-sync.service 正在同步；为避免替换运行中的程序，本次升级已停止。请等待任务结束后重试。" >&2
  exit 1
fi

if [ -z "$BINARY_SOURCE" ]; then
  if ! command -v go >/dev/null 2>&1; then
    echo "未找到 Go。请在开发机运行：GOOS=linux GOARCH=amd64 go build -o dist/jxnu-backend ./backend/cmd/jxnu-backend" >&2
    echo "然后：scp dist/jxnu-backend <VPS别名>:/tmp/jxnu-backend && ./deploy/install-backend.sh /tmp/jxnu-backend" >&2
    exit 1
  fi
  BINARY_SOURCE="$(mktemp)"
  (cd "$REPO_DIR/backend" && go build -trimpath -ldflags="-s -w" -o "$BINARY_SOURCE" ./cmd/jxnu-backend)
fi

test -f "$BINARY_SOURCE"
install -m 0755 "$BINARY_SOURCE" "$APP_DIR/jxnu-backend.new"
mv -f "$APP_DIR/jxnu-backend.new" "$APP_DIR/jxnu-backend"

read_legacy_value() {
  local key="$1" file value
  shift
  for file in "$@"; do
    [ -f "$file" ] || continue
    value="$(sed -n "s/^${key}=//p" "$file" | tail -n 1)"
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  done
  return 1
}

if [ ! -f "$ENV_FILE" ]; then
  ADMIN_PASSWORD_VALUE="$(read_legacy_value ADMIN_PASSWORD "$HOME/apps/jxnu-admin/admin.env" || true)"
  ADMIN_PASSWORD_GENERATED=false
  if [ -z "$ADMIN_PASSWORD_VALUE" ]; then
    ADMIN_PASSWORD_VALUE="$(openssl rand -hex 20)"
    ADMIN_PASSWORD_GENERATED=true
  fi
  XK_USERNAME_VALUE="$(read_legacy_value XK_USERNAME "$HOME/apps/jxnu-live/live.env" "$HOME/apps/jxnu-kkap/sync.env" || true)"
  XK_PASSWORD_VALUE="$(read_legacy_value XK_PASSWORD "$HOME/apps/jxnu-live/live.env" "$HOME/apps/jxnu-kkap/sync.env" || true)"
  LIVE_SECRET_VALUE="$(read_legacy_value LIVE_SECRET "$HOME/apps/jxnu-live/live.env" || true)"
  CF_ACCOUNT_VALUE="$(read_legacy_value CF_ACCOUNT_ID "$HOME/apps/jxnu-admin/admin.env" || true)"
  CF_TOKEN_VALUE="$(read_legacy_value CF_API_TOKEN "$HOME/apps/jxnu-admin/admin.env" || true)"
  {
    printf 'PUBLIC_ADDR=127.0.0.1:8787\nLIVE_ADDR=127.0.0.1:8788\nADMIN_ADDR=127.0.0.1:8790\n'
    printf 'REPO_DIR=%s\nBACKEND_CONFIG=%s\nSYNC_LOCK=%s\n' "$REPO_DIR" "$CONFIG_FILE" "$APP_DIR/sync.lock"
    printf 'ADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD_VALUE"
    printf 'XK_USERNAME=%s\nXK_PASSWORD=%s\nLIVE_SECRET=%s\n' "$XK_USERNAME_VALUE" "$XK_PASSWORD_VALUE" "$LIVE_SECRET_VALUE"
    printf 'CF_ACCOUNT_ID=%s\nCF_API_TOKEN=%s\nCF_PAGES_PROJECT=jxnu-elective-plus\n' "$CF_ACCOUNT_VALUE" "$CF_TOKEN_VALUE"
  } >"$ENV_FILE"
  chmod 600 "$ENV_FILE"
  if [ "$ADMIN_PASSWORD_GENERATED" = true ]; then
    printf '\n首次安装生成的管理面板密码：%s\n请立即保存。\n\n' "$ADMIN_PASSWORD_VALUE"
  else
    echo "已沿用旧管理面板密码。"
  fi
fi

# 早期 Go 迁移版本只在 backend.env 不存在时复制 Cloudflare 凭据。如果该文件先由
# 示例模板创建，两个空键会永久跳过迁移，导致新版 AI 配置页无法连接 Pages API。
# 升级时只补空值，绝不覆盖维护者已经显式填写的新凭据。
backfill_legacy_env_key() {
  local key="$1" legacy_file="$2" current legacy_value tmp
  current="$(read_legacy_value "$key" "$ENV_FILE" || true)"
  [ -z "$current" ] || return 0
  legacy_value="$(read_legacy_value "$key" "$legacy_file" || true)"
  [ -n "$legacy_value" ] || return 0
  tmp="$(mktemp "$APP_DIR/.backend.env.XXXXXX")"
  awk -v key="$key" -v value="$legacy_value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$ENV_FILE" >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$ENV_FILE"
}

backfill_legacy_env_key CF_ACCOUNT_ID "$HOME/apps/jxnu-admin/admin.env"
backfill_legacy_env_key CF_API_TOKEN "$HOME/apps/jxnu-admin/admin.env"

if [ ! -f "$CONFIG_FILE" ]; then
  install -m 0600 "$SCRIPT_DIR/backend.config.example.json" "$CONFIG_FILE"
fi

install -m 0644 "$SCRIPT_DIR/jxnu-backend.service" "$UNIT_DIR/jxnu-backend.service"
install -m 0644 "$SCRIPT_DIR/jxnu-sync.service" "$UNIT_DIR/jxnu-sync.service"
install -m 0644 "$SCRIPT_DIR/jxnu-sync.timer" "$UNIT_DIR/jxnu-sync.timer"

# 升级前保存当前可用快照，新进程可立即对外服务并在后台刷新，避免冷启动
# 抓取数千行期间出现 503。旧 Python 与新 Go 的公开响应都兼容该结构。
SNAPSHOT_FILE="$APP_DIR/enrollment_snapshot.json"
SNAPSHOT_TMP="$APP_DIR/.enrollment_snapshot.install.tmp"
if curl -fsS --max-time 10 http://127.0.0.1:8787/api/enrollments >"$SNAPSHOT_TMP" \
  && grep -q '"items"' "$SNAPSHOT_TMP"; then
  chmod 600 "$SNAPSHOT_TMP"
  mv -f "$SNAPSHOT_TMP" "$SNAPSHOT_FILE"
else
  rm -f "$SNAPSHOT_TMP"
fi

# 先释放旧服务占用的三个端口。旧 unit 和脚本保留，可在新服务启动失败时回滚。
systemctl --user stop kkap-realtime.service jxnu-live.service jxnu-admin.service kkap-schedule.timer 2>/dev/null || true
systemctl --user daemon-reload
if ! systemctl --user enable jxnu-backend.service jxnu-sync.timer \
  || ! systemctl --user restart jxnu-backend.service \
  || ! systemctl --user start jxnu-sync.timer; then
  systemctl --user restart kkap-realtime.service jxnu-live.service jxnu-admin.service 2>/dev/null || true
  systemctl --user start kkap-schedule.timer 2>/dev/null || true
  exit 1
fi

healthy=false
# 实时人数首份快照要拉取数千行，冷启动通常需要二三十秒。给足窗口，
# 同时每两秒检查一次，避免固定长等待。
for _ in $(seq 1 45); do
  if curl -fsS --max-time 5 http://127.0.0.1:8787/healthz >/dev/null 2>&1 \
    && curl -fsS --max-time 5 http://127.0.0.1:8788/healthz >/dev/null 2>&1 \
    && curl -fsS --max-time 5 http://127.0.0.1:8790/healthz >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 2
done
if [ "$healthy" != true ]; then
  echo "新后端健康检查失败，正在恢复旧服务。" >&2
  systemctl --user disable --now jxnu-backend.service jxnu-sync.timer 2>/dev/null || true
  systemctl --user restart kkap-realtime.service jxnu-live.service jxnu-admin.service 2>/dev/null || true
  systemctl --user start kkap-schedule.timer 2>/dev/null || true
  exit 1
fi

systemctl --user disable kkap-realtime.service jxnu-live.service jxnu-admin.service kkap-schedule.timer 2>/dev/null || true
echo "Go 后端安装完成。面板仍通过 SSH 隧道访问 127.0.0.1:8790。"
