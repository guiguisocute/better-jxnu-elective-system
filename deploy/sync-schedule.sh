#!/usr/bin/env bash
# 开课安排 + 实时容量 安全增量同步（VPS 定时跑）。
#   抓 Public_Kkap(无登录) → 复用旧 enrichment → xk 实抓容量(真账号登录) → build_data → 校验 → 仅在有变化时 commit+push。
# 安全闸：抓取行数过少 / 产物异常 / 容量可见课程数过少 一律不采用当次结果；git pull --ff-only 避免分叉覆盖手动改动。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

log() { echo "[$(date -u +%FT%TZ)] $*"; }

# 凭据（XK_USERNAME/XK_PASSWORD，供下面容量爬取用）+ 可选的 SYNC_* 参数覆盖：VPS 上放在仓库外的
# ~/apps/jxnu-kkap/sync.env（模板见 deploy/sync.env.example），不随仓库一起同步/提交。
SYNC_ENV="$HOME/apps/jxnu-kkap/sync.env"
if [ -f "$SYNC_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$SYNC_ENV"
  set +a
fi

# 共享锁：与管理面板（tools/admin_service.py）互斥，避免两边同时改仓库/推送。
# 目录可能尚未创建（首次部署）——bash 非交互下 exec 重定向失败会直接退出 shell，先确保目录存在。
mkdir -p "$HOME/apps/jxnu-kkap"
exec 9>"$HOME/apps/jxnu-kkap/sync.lock"
flock -n 9 || { echo "[sync] 锁被占用（管理面板或另一轮同步进行中），跳过本轮"; exit 0; }

# 同步参数：默认写死，sync.env 里放 SYNC_* 即可覆盖（不用改脚本）。
SEM="${SYNC_SEM:-2026-09}"
RAW="data/semesters/$SEM/raw/formal_schedule.json"
CAPACITY_RAW="data/semesters/$SEM/raw/formal_capacity.json"
MIN_SECTIONS="${SYNC_MIN_SECTIONS:-7000}"
MIN_CAPACITY_VISIBLE="${SYNC_MIN_CAPACITY_VISIBLE:-300}"

# 0) 同步远端（快进；若分叉则放弃本次，等人工处理，绝不强推）
git pull --ff-only origin main || { log "git pull 非快进，跳过本次同步"; exit 0; }

# 1) 开课安排：抓取 + 复用旧 enrichment（脚本内含 --min-rows 安全闸，抓太少会自己 abort）
python3 tools/kkap_schedule_export.py --merge-from "$RAW" --min-rows "${SYNC_MIN_ROWS:-6000}" -o "$RAW.tmp"
mv -f "$RAW.tmp" "$RAW"

# 2) 实时容量：真账号登录 xk 实抓（教学班容量，不是已选人数——已选人数走单独的 kkap-realtime 服务）。
#    没配凭据 / 登录或抓取失败 / 可见课程数过少（选课阶段变了导致 Step 前缀失配等）→ 丢弃这次结果，
#    保留仓库里上一份，不影响本次开课安排那部分的 push。
if [ -n "${XK_USERNAME:-}" ] && [ -n "${XK_PASSWORD:-}" ]; then
  if python3 tools/crawl_capacity.py --sem "$SEM" -o "$CAPACITY_RAW.tmp"; then
    VISIBLE=$(python3 -c "import json;print(json.load(open('$CAPACITY_RAW.tmp',encoding='utf-8'))['summary']['visible'])" 2>/dev/null || echo 0)
    if [ "$VISIBLE" -ge "$MIN_CAPACITY_VISIBLE" ]; then
      mv -f "$CAPACITY_RAW.tmp" "$CAPACITY_RAW"
      log "[容量] 可见 $VISIBLE 门，已更新"
    else
      log "[容量][跳过] 可见仅 $VISIBLE (<$MIN_CAPACITY_VISIBLE)，可能选课阶段变了（检查 XK_STEP），保留旧数据"
      rm -f "$CAPACITY_RAW.tmp"
    fi
  else
    log "[容量][跳过] 爬取失败（登录/网络），保留旧数据"
    rm -f "$CAPACITY_RAW.tmp"
  fi
else
  log "[容量][跳过] 未配置 XK_USERNAME/XK_PASSWORD（见 $SYNC_ENV）"
fi

# 3) 重建产物
python3 build_data.py >/dev/null

# 4) 判变闸只认「产物」（public/ + data/master/）。raw 每小时必变
#    （formal_capacity 的 fetched_at/config 摘要、formal_schedule 的 序号 重排），
#    不能作为是否提交的依据 —— 产物没变就丢弃 raw 抖动，不产生无效 commit。
if git diff --quiet -- public/ data/master/; then
  git checkout -- data/semesters/
  log "产物无变化（raw 仅时间戳/序号抖动，已丢弃），结束"
  exit 0
fi

# 5) 产物合理性闸：section 数太少 = 异常 → 全部回滚，不推
N=$(python3 -c "import json;print(len(json.load(open('public/formal_sections.json',encoding='utf-8'))))")
if [ "$N" -lt "$MIN_SECTIONS" ]; then
  log "[ABORT] formal_sections 仅 $N (<$MIN_SECTIONS)，回滚不推"
  git checkout -- public/ data/
  exit 1
fi

# 6) 提交并推送（触发 Cloudflare Pages 部署）。
#    提交信息由 sync_commit_summary.py 生成：首行 = 容量/班级/课程变化摘要，正文 = 明细。
#    生成失败时回退到旧的通用文案，绝不因 message 生成问题丢掉一次数据推送。
MSG_FILE="$(mktemp)"
if ! python3 tools/sync_commit_summary.py >"$MSG_FILE" || ! [ -s "$MSG_FILE" ]; then
  echo "data: 自动同步开课安排+实时容量 (kkap $(date -u +%FT%TZ)); sections=$N" >"$MSG_FILE"
fi
git add public/ "$RAW" "$CAPACITY_RAW" data/master/
# 源配置一并入库：public/app_config.json 由 data/build_config.json 派生，只提交派生不提交源会漂移；
# 文件可能尚未创建（管理面板首次保存才生成），git add 不存在的路径会报错，先判存在。
if [ -f data/build_config.json ]; then
  git add data/build_config.json
fi
git commit -q -F "$MSG_FILE"
rm -f "$MSG_FILE"
git push origin main
log "[已推送] formal_sections=$N"
