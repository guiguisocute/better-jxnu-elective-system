#!/usr/bin/env bash
# 采集机上的本地备份。做两件事：
#   1) 把仓库全量镜像到一个 bare 库（所有分支、tag、历史）；
#   2) 快照那些不在 git 里、丢了要人工重配的运行期状态（凭据、面板配置、缓存）。
#
# 能防住什么：误删/误改工作副本、坏 rebase、GitHub 不可达或仓库被删。
# **防不住什么：这台机器的磁盘挂掉。** 备份和源数据在同一块盘上。
# 真要防硬件故障，得把 BACKUP_DIR 再同步到另一台机器——这个脚本不做，
# 因为那意味着把含密钥的快照送出这台机器，需要单独决策。
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/better-jxnu-elective-system}"
APP_DIR="${APP_DIR:-$HOME/apps/jxnu-backend}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/jxnu}"
MIRROR="$BACKUP_DIR/repo.git"
STATE_DIR="$BACKUP_DIR/state"
KEEP_STATE=14

mkdir -p "$BACKUP_DIR" "$STATE_DIR"
chmod 700 "$BACKUP_DIR" "$STATE_DIR"

# ---- 1. 仓库镜像 ----------------------------------------------------------
# 从本地工作副本抓，不走网络：备份的意义之一就是 GitHub 不可达时仍然有东西。
# 工作副本自己会被同步任务保持与远端一致。
if [ ! -d "$MIRROR" ]; then
  git clone --mirror "$REPO_DIR" "$MIRROR"
  echo "[备份] 已初始化镜像 $MIRROR"
else
  # --prune 会删掉源端已消失的引用；这是"镜像"的语义。历史本身不会丢，
  # 因为下面的 reflog 保留期给了找回窗口。
  git --git-dir="$MIRROR" fetch --prune origin '+refs/*:refs/*'
fi
# 镜像库默认不开 reflog；显式打开，误删分支后还能捞回来。
git --git-dir="$MIRROR" config core.logAllRefUpdates true
git --git-dir="$MIRROR" config gc.reflogExpire "90 days"
git --git-dir="$MIRROR" config gc.reflogExpireUnreachable "90 days"

COMMITS=$(git --git-dir="$MIRROR" rev-list --count --all)
SIZE=$(du -sh "$MIRROR" | cut -f1)

# ---- 2. 运行期状态快照 ----------------------------------------------------
# backend.env 里有教务账号、LIVE_SECRET、面板密码、CF token；
# cap/.env 里有 Cap 的 ADMIN_KEY。丢了不会导致数据损坏，但要人工重配一遍。
# 全程 0600，且只落在这台机器上。
STAMP=$(date +%Y%m%d-%H%M%S)
SNAP="$STATE_DIR/state-$STAMP.tar.gz"
umask 077
tar czf "$SNAP" \
  -C "$APP_DIR" $(cd "$APP_DIR" && ls backend.env config.json last_sync.json acquisition_watch.json student_terms.json freshman_watch.json 2>/dev/null) \
  -C "$REPO_DIR/deploy/cap" $(cd "$REPO_DIR/deploy/cap" && ls .env 2>/dev/null) 2>/dev/null || true
chmod 600 "$SNAP"

# 只留最近 KEEP_STATE 份，避免无限增长。
ls -1t "$STATE_DIR"/state-*.tar.gz 2>/dev/null | tail -n +$((KEEP_STATE + 1)) | xargs -r rm -f

echo "[备份] 镜像 $COMMITS 个提交 / $SIZE；状态快照 $(basename "$SNAP") ($(du -h "$SNAP" | cut -f1))"
