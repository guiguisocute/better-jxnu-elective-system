#!/usr/bin/env bash
# 方案A · 开课安排安全增量同步（VPS 定时跑）。
#   抓 Public_Kkap(无登录) → 复用旧 enrichment → build_data → 校验 → 仅在有变化时 commit+push。
# 安全闸：抓取行数过少 / 产物异常 一律回滚不推；git pull --ff-only 避免分叉覆盖你的手动改动。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
RAW="data/semesters/2026-09/raw/formal_schedule.json"
MIN_SECTIONS=7000

log() { echo "[$(date -u +%FT%TZ)] $*"; }

# 0) 同步远端（快进；若分叉则放弃本次，等人工处理，绝不强推）
git pull --ff-only origin main || { log "git pull 非快进，跳过本次同步"; exit 0; }

# 1) 抓取 + 复用旧 enrichment（脚本内含 --min-rows 安全闸，抓太少会自己 abort）
python3 tools/kkap_schedule_export.py --merge-from "$RAW" --min-rows 6000 -o "$RAW.tmp"
mv -f "$RAW.tmp" "$RAW"

# 2) 重建产物
python3 build_data.py >/dev/null

# 3) 没变化就收工
if git diff --quiet -- public/ data/; then
  log "无变化，结束"
  exit 0
fi

# 4) 产物合理性闸：section 数太少 = 异常 → 全部回滚，不推
N=$(python3 -c "import json;print(len(json.load(open('public/formal_sections.json',encoding='utf-8'))))")
if [ "$N" -lt "$MIN_SECTIONS" ]; then
  log "[ABORT] formal_sections 仅 $N (<$MIN_SECTIONS)，回滚不推"
  git checkout -- public/ data/
  exit 1
fi

# 5) 提交并推送（触发 Cloudflare Pages 部署）
git add public/ "$RAW" data/master/
git commit -q -m "data: 自动同步开课安排 (kkap $(date -u +%FT%TZ)); sections=$N"
git push origin main
log "[已推送] formal_sections=$N"
