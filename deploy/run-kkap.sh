#!/bin/sh
set -eu

APP_DIR="${HOME}/apps/jxnu-kkap"
cd "$APP_DIR"

set -a
. "$APP_DIR/kkap.env"
set +a

mkdir -p "$APP_DIR/logs"
exec /usr/bin/flock -n "$APP_DIR/kkap.lock" \
  /usr/bin/python3 "$APP_DIR/kkap_service.py" \
  >>"$APP_DIR/logs/service.log" 2>&1
