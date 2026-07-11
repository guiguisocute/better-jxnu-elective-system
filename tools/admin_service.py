#!/usr/bin/env python3
"""
jxnu-admin —— VPS 运维配置管理面板（单文件、零第三方依赖 WebUI）。

照 kkap_service.py / live_service.py 的范式：标准库 ThreadingHTTPServer + env 配置 +
systemd --user 常驻。服务端渲染 HTML（无 JS、无外链 CDN），所有运维动作都是表单 POST。
唯一的可选依赖是 requests（仅 Cloudflare API 部分用；VPS 系统级已装，缺失时页面给指引）。

════ 安全模型（内网面板，纵深防御）════
1. 网络面：默认只绑 127.0.0.1（ADMIN_BIND），公网不可达；访问走 SSH 隧道：
     ssh -L 8790:127.0.0.1:8790 <VPS别名>（别名/跳板/密钥在本地 ~/.ssh/config 配置，不写进仓库）
   然后浏览器开 http://127.0.0.1:8790 。
2. 认证：单密码 ADMIN_PASSWORD（admin.env，600 权限），hmac.compare_digest 恒时比较；
   会话 token = secrets.token_hex(32)，存进程内存（服务重启即全体下线），8 小时过期；
   Cookie HttpOnly + SameSite=Strict + Path=/；连续失败≥5 次后每次登录尝试先 sleep 3s。
3. CSRF：所有 POST（除 /login 本身，登录前尚无会话）校验会话绑定的 csrf token。
4. 输出面：所有动态内容经 html.escape；键名含 PASSWORD/SECRET/TOKEN/KEY 的 env 值
   一律打码（长度>4 显示 …末4位，否则 ****）；编辑表单留空 = 不修改
   （LIVE_PLANNING_TERM_OVERRIDE 的「删除」用显式复选框表达，避免误清）。
5. 子进程面：一律 subprocess.run(argv 列表, shell=False, timeout, capture_output)；
   命令封装成白名单函数（systemctl --user / journalctl --user / git / python3），
   用户输入永不进入命令位——只作白名单键选择或写入文件的内容。
6. 仓库写操作走 repo_op()：停 kkap-schedule.timer → 等 service 空闲 → flock sync.lock →
   git pull --ff-only → 改文件 → build_data.py + sanity 闸 → commit/push → 恢复 timer。
   全程 threading.Lock 互斥，并发第二个写操作直接 409，绝不强推。

Windows 兼容仅为本机只读冒烟：fcntl 缺失 → 空锁实现（页面标注「锁仅在 VPS 生效」）；
systemctl/journalctl 缺失 → 对应区域显示「本机不可用」而非 500。生产环境是 Debian 12。
"""

from __future__ import annotations

import glob as globmod
import hmac
import html
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

try:  # Linux 专有；Windows 冒烟时降级为「无锁」并在页面标注
    import fcntl
    HAVE_FCNTL = True
except ImportError:  # pragma: no cover - Windows only
    fcntl = None  # type: ignore[assignment]
    HAVE_FCNTL = False

try:  # 仅 Cloudflare API 用；VPS 系统级可用，缺失时 /ai 页给指引
    import requests  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover
    requests = None  # type: ignore[assignment]

# ──────────────────────────── 配置（全部来自 env / admin.env） ────────────────────────────

HOME = os.path.expanduser("~")
BIND = os.environ.get("ADMIN_BIND", "127.0.0.1")
PORT = int(os.environ.get("ADMIN_PORT", "8790"))
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
REPO_DIR = os.environ.get("REPO_DIR", os.path.join(HOME, "better-jxnu-elective-system"))
KKAP_ENV_PATH = os.environ.get("KKAP_ENV", os.path.join(HOME, "apps/jxnu-kkap/kkap.env"))
SYNC_ENV_PATH = os.environ.get("SYNC_ENV", os.path.join(HOME, "apps/jxnu-kkap/sync.env"))
LIVE_ENV_PATH = os.environ.get("LIVE_ENV", os.path.join(HOME, "apps/jxnu-live/live.env"))
SYNC_LOCK_PATH = os.environ.get("SYNC_LOCK", os.path.join(HOME, "apps/jxnu-kkap/sync.lock"))
CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "")
CF_PAGES_PROJECT = os.environ.get("CF_PAGES_PROJECT", "jxnu-elective-plus")

SESSION_TTL = 8 * 3600          # 会话 8 小时
LOGIN_FAIL_THRESHOLD = 5        # 连续失败 5 次后开始惩罚
LOGIN_FAIL_SLEEP = 3.0          # 惩罚：每次登录尝试前 sleep 3s
COOKIE_NAME = "jxnu_admin_sess"
PY = sys.executable or "python3"

HAVE_SYSTEMCTL = shutil.which("systemctl") is not None
HAVE_JOURNALCTL = shutil.which("journalctl") is not None

SEM_RE = re.compile(r"\d{4}-(03|09)")
# env 值统一禁掉会破坏 shell source（sync.env 被 bash 源入）/ EnvironmentFile 的字符；
# 密码若真含这些字符只能 SSH 手改（页面有提示）。
TOKEN_RE = re.compile(r"[^\s'\"\\$`#]{1,200}")
TERM_OVERRIDE_RE = re.compile(r"\d{2}-\d{2}第\d学期")
SENSITIVE_KEY_RE = re.compile(r"PASSWORD|SECRET|TOKEN|KEY", re.I)

# 可 restart 的服务 / 可看日志的单元 —— 白名单，用户输入只作键选择
RESTART_UNITS = {"kkap-realtime", "jxnu-live", "jxnu-admin"}
LOG_UNITS = ["kkap-schedule", "kkap-realtime", "jxnu-live", "jxnu-admin"]


class AdminError(Exception):
    """预期内的操作失败（校验不过 / 某一步命令失败），message 面向用户。"""


class AdminBusy(Exception):
    """repo_op 互斥锁被占：已有仓库写操作进行中。"""


# ──────────────────────────── 子进程封装（argv 白名单、shell=False） ────────────────────────────

def run_cmd(argv: list[str], timeout: float = 30, cwd: str | None = None,
            env: dict[str, str] | None = None) -> dict:
    """跑一条命令，永不 shell=False 以外的方式。返回 {argv, rc, out, err, ok}。"""
    try:
        p = subprocess.run(
            argv, shell=False, timeout=timeout, capture_output=True,
            text=True, encoding="utf-8", errors="replace", cwd=cwd, env=env,
        )
        return {"argv": argv, "rc": p.returncode, "out": p.stdout, "err": p.stderr,
                "ok": p.returncode == 0}
    except FileNotFoundError:
        return {"argv": argv, "rc": 127, "out": "",
                "err": f"命令不存在：{argv[0]}（本机不可用；生产 VPS 上应存在）", "ok": False}
    except subprocess.TimeoutExpired:
        return {"argv": argv, "rc": -1, "out": "", "err": f"超时（>{timeout:.0f}s）", "ok": False}


def child_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """子进程环境：剔除面板自身的敏感键（ADMIN_PASSWORD 与 CF_ 前缀凭据不下发给 build/爬虫），
    可按需叠加额外键（如 sync.env 的 XK_* 凭据）。"""
    env = {k: v for k, v in os.environ.items()
           if k != "ADMIN_PASSWORD" and not k.startswith("CF_")}
    if extra:
        env.update(extra)
    return env


def note_step(title: str, text: str = "", ok: bool = True) -> dict:
    """非命令类的步骤记录（纯说明）。"""
    return {"title": title, "argv": None, "rc": None, "out": text, "err": "", "ok": ok}


def run_step(steps: list[dict], title: str, argv: list[str], must: bool = True, **kw) -> dict:
    """跑命令并记录到步骤列表；must=True 时失败抛 AdminError 终止流程。"""
    r = run_cmd(argv, **kw)
    steps.append({"title": title, **r})
    if must and not r["ok"]:
        raise AdminError(f"{title} 失败（rc={r['rc']}）")
    return r


# ──────────────────────────── env 文件读写（保注释、保未列键、600 权限） ────────────────────────────

def read_env_file(path: str) -> dict[str, str]:
    """解析 KEY=VALUE 行（跳过注释/空行）。仅用于展示与合并子进程 env。"""
    data: dict[str, str] = {}
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                m = re.match(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
                if not m:
                    continue
                key, val = m.group(1), m.group(2).strip()
                if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                    val = val[1:-1]
                data[key] = val
    except OSError:
        return {}
    return data


ENV_WRITE_LOCK = threading.Lock()  # env 文件读改写全程互斥：并发保存同一文件时防「后写覆盖先写」丢更新


def write_env_updates(path: str, updates: dict[str, str | None]) -> None:
    """改写 env 文件：更新/追加 updates 中的键（None=删除该键），
    其余行（注释、未列出的键）原样保留；原子替换 + 全程 600 权限（临时文件以 0o600 创建，无 umask 窗口）。"""
    with ENV_WRITE_LOCK:
        lines: list[str] = []
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                lines = fh.read().splitlines()
        seen: set[str] = set()
        out: list[str] = []
        for line in lines:
            m = re.match(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=", line)
            key = m.group(1) if m else None
            if key and key in updates:
                if key in seen:
                    continue  # 丢弃重复定义行
                seen.add(key)
                if updates[key] is None:
                    continue  # 删除该键
                out.append(f"{key}={updates[key]}")
            else:
                out.append(line)
        for key, val in updates.items():
            if key not in seen and val is not None:
                out.append(f"{key}={val}")
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        tmp = path + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)  # 落盘即 600，不给 umask 留窗口
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join(out) + "\n")
        os.chmod(tmp, 0o600)  # O_CREAT 的 mode 只对新建生效；tmp 残留复用时兜底
        os.replace(tmp, path)
        os.chmod(path, 0o600)


def mask_value(key: str, val: str) -> str:
    """敏感键（PASSWORD/SECRET/TOKEN/KEY）打码：>4 位显示 …末4位，否则 ****。"""
    if not SENSITIVE_KEY_RE.search(key):
        return val
    if not val:
        return ""
    return ("…" + val[-4:]) if len(val) > 4 else "****"


# ──────────────────────────── 值校验器（白名单键 → 各自格式闸） ────────────────────────────

def v_re(pattern: re.Pattern, hint: str):
    def check(v: str) -> str:
        if not pattern.fullmatch(v):
            raise AdminError(f"{hint}（收到：{v!r}）")
        return v
    return check


def v_int(min_v: int = 0, max_v: int = 10 ** 9):
    def check(v: str) -> str:
        if not re.fullmatch(r"\d+", v):
            raise AdminError(f"应为整数（收到：{v!r}）")
        n = int(v)
        if n < min_v or n > max_v:
            raise AdminError(f"整数超出范围 [{min_v}, {max_v}]（收到：{n}）")
        return str(n)
    return check


v_sem = v_re(SEM_RE, "学期格式应为 YYYY-03 / YYYY-09")
v_token = v_re(TOKEN_RE, "值不能含空白/引号/$/`/#/反斜杠（这些会破坏 env 文件解析），且≤200 字符")
v_term_override = v_re(TERM_OVERRIDE_RE, "格式应如 26-27第1学期")

# 每个 env 文件的可编辑键白名单 + 校验器 + 保存后建议重启的服务
ENV_SPECS: dict[str, dict] = {
    "kkap": {
        "path": KKAP_ENV_PATH,
        "label": "kkap.env（实时人数快照服务）",
        "restart": "kkap-realtime",
        "keys": {
            "KKAP_SEMESTER": v_sem,
            "KKAP_REFRESH_SECONDS": v_int(10),
            "KKAP_ALLOWED_ORIGINS": v_token,
        },
    },
    "sync": {
        "path": SYNC_ENV_PATH,
        "label": "sync.env（每小时数据同步）",
        "restart": None,  # oneshot 脚本每次自读 env，无需重启
        "keys": {
            "SYNC_SEM": v_sem,
            "XK_STEP": v_re(re.compile(r"Step[1-9]"), "应为 Step1-Step9"),
            "XK_USERNAME": v_token,
            "XK_PASSWORD": v_token,
            "SYNC_MIN_SECTIONS": v_int(0),
            "SYNC_MIN_CAPACITY_VISIBLE": v_int(0),
            "SYNC_MIN_ROWS": v_int(0),
        },
    },
    "live": {
        "path": LIVE_ENV_PATH,
        "label": "live.env（实时课表 / 学号导入上游）",
        "restart": "jxnu-live",
        "keys": {
            "LIVE_PLANNING_TERM_OVERRIDE": v_term_override,  # 支持显式清除（复选框）
            "LIVE_CACHE_TTL": v_int(0),
            "LIVE_SECRET": v_token,
            "XK_USERNAME": v_token,
            "XK_PASSWORD": v_token,
        },
    },
}

ENV_FIELD_HINTS: dict[str, str] = {
    "KKAP_SEMESTER": "实时人数抓取的学期（YYYY-03 / YYYY-09）",
    "KKAP_REFRESH_SECONDS": "抓取间隔秒数（整数 ≥10）",
    "KKAP_ALLOWED_ORIGINS": "CORS 允许来源，逗号分隔（不要空格）",
    "SYNC_SEM": "每小时同步写入的学期目录（YYYY-03 / YYYY-09）",
    "XK_STEP": "xk 容量爬取的阶段前缀（Step1-9；阶段变了先用「探测容量阶段」核对）",
    "XK_USERNAME": "教务账号（学号）",
    "XK_PASSWORD": "教务密码（含引号/空格/$ 等特殊字符时请 SSH 手改）",
    "SYNC_MIN_SECTIONS": "产物 formal_sections 最少条数安全闸（整数）",
    "SYNC_MIN_CAPACITY_VISIBLE": "容量爬取可见课程数最少安全闸（整数）",
    "SYNC_MIN_ROWS": "开课安排抓取行数最少安全闸（整数）",
    "LIVE_PLANNING_TERM_OVERRIDE": "学号导入的规划学期覆盖；空=自动取教务默认；格式示例 26-27第1学期",
    "LIVE_CACHE_TTL": "per-学号结果缓存秒数（整数）",
    "LIVE_SECRET": "CF Pages Function 调用本服务的共享密钥",
}

# Cloudflare Pages 环境变量白名单（/ai 页）
CF_PLAIN_KEYS = ["AI_BASE_URL", "AI_MODEL", "AI_VOTER_DAILY", "AI_SITE_DAILY_CALLS", "AI_SITE_DAILY_TOKENS"]
CF_SECRET_KEYS = ["AI_API_KEY", "LIVE_SECRET"]
CF_INT_KEYS = {"AI_VOTER_DAILY", "AI_SITE_DAILY_CALLS", "AI_SITE_DAILY_TOKENS"}


# ──────────────────────────── 会话 / 登录（内存态） ────────────────────────────

SESSIONS: dict[str, dict] = {}
STATE_LOCK = threading.Lock()
LOGIN_FAILS = 0  # 连续失败计数（成功登录清零）


def new_session() -> tuple[str, dict]:
    token = secrets.token_hex(32)
    sess = {"expires": time.time() + SESSION_TTL, "csrf": secrets.token_hex(16)}
    with STATE_LOCK:
        # 顺手清理过期会话
        dead = [t for t, s in SESSIONS.items() if s["expires"] < time.time()]
        for t in dead:
            SESSIONS.pop(t, None)
        SESSIONS[token] = sess
    return token, sess


def get_session(token: str | None) -> dict | None:
    if not token:
        return None
    with STATE_LOCK:
        sess = SESSIONS.get(token)
        if not sess:
            return None
        if sess["expires"] < time.time():
            SESSIONS.pop(token, None)
            return None
        return sess


def drop_session(token: str | None) -> None:
    if token:
        with STATE_LOCK:
            SESSIONS.pop(token, None)


def login_attempt(password: str) -> tuple[bool, str | None, dict | None]:
    """恒时比较 + 失败惩罚。返回 (成功?, cookie_token, session)。"""
    global LOGIN_FAILS
    with STATE_LOCK:
        fails = LOGIN_FAILS
    if fails >= LOGIN_FAIL_THRESHOLD:
        time.sleep(LOGIN_FAIL_SLEEP)  # 连续失败后的每次尝试都先罚站
    ok = bool(ADMIN_PASSWORD) and hmac.compare_digest(password.encode(), ADMIN_PASSWORD.encode())
    with STATE_LOCK:
        LOGIN_FAILS = 0 if ok else LOGIN_FAILS + 1
    if not ok:
        return False, None, None
    token, sess = new_session()
    return True, token, sess


# ──────────────────────────── 仓库 / 配置数据读取 ────────────────────────────

def semesters_dir() -> str:
    return os.path.join(REPO_DIR, "data", "semesters")


def build_config_path() -> str:
    return os.path.join(REPO_DIR, "data", "build_config.json")


def list_semesters() -> list[tuple[str, bool]]:
    """扫 data/semesters/*/meta.json → [(label=目录名, isCurrent)]。目录名是学期权威。"""
    out: list[tuple[str, bool]] = []
    for meta_path in sorted(globmod.glob(os.path.join(semesters_dir(), "*", "meta.json"))):
        label = os.path.basename(os.path.dirname(meta_path))
        cur = False
        try:
            with open(meta_path, encoding="utf-8") as fh:
                cur = bool(json.load(fh).get("isCurrent"))
        except (OSError, ValueError):
            pass
        out.append((label, cur))
    return out


def read_build_config() -> tuple[dict | None, str | None]:
    """读 data/build_config.json。返回 (dict|None, 错误说明|None)。文件可能尚未由并行开发落地。"""
    path = build_config_path()
    if not os.path.exists(path):
        return None, "文件不存在"
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            return None, "顶层不是对象"
        return data, None
    except (OSError, ValueError) as exc:
        return None, f"解析失败：{exc}"


def semester_knobs() -> tuple[list[tuple[str, str]], list[str]]:
    """六个学期旋钮的当前值 + 用于一致性检查的四个核心值（去掉未设置项）。"""
    sems = list_semesters()
    cur_labels = [label for label, cur in sems if cur]
    cfg, cfg_err = read_build_config()
    kkap = read_env_file(KKAP_ENV_PATH)
    sync = read_env_file(SYNC_ENV_PATH)

    def cfg_show(key: str) -> str:
        if cfg is None:
            return f"(build_config.json {cfg_err})"
        val = cfg.get(key)
        if val is None:
            return "(未设置)"
        return json.dumps(val, ensure_ascii=False) if isinstance(val, (list, dict)) else str(val)

    cur_show = "、".join(cur_labels) if cur_labels else "(无)"
    live_sem = "" if cfg is None else str(cfg.get("liveEnrollmentSemester") or "")
    rows = [
        ("meta.json isCurrent（预选目录归属）", cur_show),
        ("build_config.json testSemesters", cfg_show("testSemesters")),
        ("build_config.json mirrorSemesters", cfg_show("mirrorSemesters")),
        ("build_config.json liveEnrollmentSemester", live_sem or cfg_show("liveEnrollmentSemester")),
        ("sync.env SYNC_SEM（每小时同步目标）", sync.get("SYNC_SEM", "(未设置)")),
        ("kkap.env KKAP_SEMESTER（实时人数）", kkap.get("KKAP_SEMESTER", "(未设置)")),
    ]
    core = [v for v in [
        cur_labels[0] if len(cur_labels) == 1 else "",
        sync.get("SYNC_SEM", ""),
        kkap.get("KKAP_SEMESTER", ""),
        live_sem,
    ] if v]
    return rows, core


# ──────────────────────────── repo_op：仓库写操作（与每小时 timer 互斥） ────────────────────────────

REPO_OP_LOCK = threading.Lock()


class _FileLock:
    """flock(sync.lock)。Windows（无 fcntl）降级为空实现，仅在 VPS 生效。"""

    def __init__(self, path: str) -> None:
        self.path = path
        self.fh = None

    def acquire(self) -> str:
        parent = os.path.dirname(self.path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self.fh = open(self.path, "w", encoding="utf-8")
        if not HAVE_FCNTL:
            return "fcntl 不可用（Windows 冒烟环境）——文件锁仅在 VPS 生效"
        try:
            fcntl.flock(self.fh, fcntl.LOCK_EX | fcntl.LOCK_NB)  # type: ignore[union-attr]
        except OSError:
            self.fh.close()
            self.fh = None
            raise AdminError("拿不到 sync.lock（可能同步脚本正在运行），请稍后重试")
        return f"已持有 {self.path}"

    def release(self) -> None:
        if self.fh is not None:
            if HAVE_FCNTL:
                try:
                    fcntl.flock(self.fh, fcntl.LOCK_UN)  # type: ignore[union-attr]
                except OSError:
                    pass
            self.fh.close()
            self.fh = None


def _git(args: list[str]) -> list[str]:
    return ["git", *args]


def _sysctl(args: list[str]) -> list[str]:
    return ["systemctl", "--user", *args]


def repo_op(desc: str, mutate_fn) -> tuple[bool, list[dict]]:
    """仓库写操作总闸（核心正确性要求：与每小时 kkap-schedule timer 互斥）。

    a) 停 timer  b) 等 service 空闲(≤300s)  c) flock sync.lock
    d) git pull --ff-only  e) mutate_fn(steps, created_paths)  f) build_data.py + sanity（失败回滚）
    g) add/commit/push（无变化跳过；push 失败 rebase 重试一次）
    finally: 释放锁 + 恢复 timer。并发第二个操作抛 AdminBusy（409）。

    mutate_fn 若首次创建了新文件，须把路径 append 进 created_paths ——
    回滚用的 git checkout 撤不掉未跟踪文件，这些路径失败时单独 os.remove。
    """
    if not REPO_OP_LOCK.acquire(blocking=False):
        raise AdminBusy()
    steps: list[dict] = []
    flock = _FileLock(SYNC_LOCK_PATH)
    flocked = False
    timer_stopped = False
    ok = False
    try:
        # a) 停 timer（Windows/无 systemd 时记录并继续，生产 VPS 必有）
        r = run_step(steps, "停止 kkap-schedule.timer（防与每小时同步撞车）",
                     _sysctl(["stop", "kkap-schedule.timer"]), must=False, timeout=30)
        # 超时（rc=-1）时 stop 可能已实际生效，finally 宁可多恢复一次（start 幂等，无副作用）
        timer_stopped = r["ok"] or r["rc"] == -1
        if not r["ok"] and r["rc"] != 127:
            raise AdminError("停止 kkap-schedule.timer 失败")

        # b) 等正在跑的 service 结束（oneshot 可能长达数分钟）
        if r["rc"] != 127:
            deadline = time.time() + 300
            while True:
                ra = run_cmd(_sysctl(["is-active", "kkap-schedule.service"]), timeout=15)
                state = (ra["out"] or ra["err"]).strip() or "unknown"
                if state not in ("active", "activating"):
                    steps.append(note_step("等待 kkap-schedule.service 空闲", f"当前状态：{state}"))
                    break
                if time.time() > deadline:
                    raise AdminError("等待 kkap-schedule.service 结束超时（300s）")
                time.sleep(3)
        else:
            steps.append(note_step("等待 kkap-schedule.service 空闲", "本机无 systemctl，跳过", ok=True))

        # c) 文件锁（与 sync-schedule.sh 的 flock 约定互斥）
        steps.append(note_step("获取 sync.lock 文件锁", flock.acquire()))
        flocked = True

        # d) 快进拉取；分叉直接放弃，绝不强推
        run_step(steps, "git pull --ff-only", _git(["pull", "--ff-only", "origin", "main"]),
                 timeout=120, cwd=REPO_DIR)

        # e+f) 改文件 + 重建 + sanity；任何失败回滚工作区
        created_paths: list[str] = []  # mutate 首次创建的未跟踪文件（git checkout 撤不掉，失败时单独删）
        try:
            mutate_fn(steps, created_paths)
            run_step(steps, "python3 build_data.py（重建产物，≤600s）",
                     [PY, "build_data.py"], timeout=600, cwd=REPO_DIR, env=child_env())
            courses_path = os.path.join(REPO_DIR, "public", "courses.json")
            with open(courses_path, encoding="utf-8") as fh:
                courses = json.load(fh)
            if not isinstance(courses, list) or len(courses) <= 1000:
                raise AdminError(f"sanity 未过：public/courses.json 仅 {len(courses) if isinstance(courses, list) else '非数组'} 条（≤1000）")
            steps.append(note_step("sanity 检查", f"public/courses.json = {len(courses)} 条，通过"))
        except Exception:
            run_step(steps, "回滚工作区（git checkout -- data/ public/）",
                     _git(["checkout", "--", "data/", "public/"]), must=False, timeout=60, cwd=REPO_DIR)
            # git checkout 只能还原已跟踪文件；本次新建的未跟踪文件（如首建的 build_config.json）
            # 逐个删除。不用 git clean -fd —— 会误伤仓库里其他合法的未跟踪内容。
            for p in created_paths:
                try:
                    if os.path.exists(p):
                        os.remove(p)
                        steps.append(note_step("删除本次新建的未跟踪文件", p))
                except OSError as rm_exc:
                    steps.append(note_step("删除新建文件失败", f"{p}: {rm_exc}", ok=False))
            raise

        # g) 提交推送（产物无变化则跳过）
        run_step(steps, "git add data/ public/", _git(["add", "data/", "public/"]),
                 timeout=60, cwd=REPO_DIR)
        rd = run_cmd(_git(["diff", "--cached", "--quiet"]), timeout=60, cwd=REPO_DIR)
        if rd["rc"] == 0:
            steps.append(note_step("变更检测", "产物无变化，跳过 commit / push"))
            ok = True
            return ok, steps
        run_step(steps, "git commit",
                 _git(["-c", "user.name=admin-panel", "-c", "user.email=admin@vps",
                       "commit", "-m", f"config: {desc}（via 管理面板）"]),
                 timeout=60, cwd=REPO_DIR)
        rp = run_step(steps, "git push origin main", _git(["push", "origin", "main"]),
                      must=False, timeout=180, cwd=REPO_DIR)
        if not rp["ok"]:
            # 与 timer 推送竞态：fetch + rebase 后重试一次
            run_step(steps, "push 失败 → git fetch origin", _git(["fetch", "origin"]),
                     timeout=120, cwd=REPO_DIR)
            rr = run_step(steps, "git rebase origin/main", _git(["rebase", "origin/main"]),
                          must=False, timeout=120, cwd=REPO_DIR)
            if not rr["ok"]:
                run_step(steps, "rebase 失败 → git rebase --abort", _git(["rebase", "--abort"]),
                         must=False, timeout=60, cwd=REPO_DIR)
                raise AdminError("push 竞态后 rebase 失败，需人工处理（提交已留在本地分支）")
            run_step(steps, "重试 git push origin main", _git(["push", "origin", "main"]),
                     timeout=180, cwd=REPO_DIR)
        ok = True
        return ok, steps
    except AdminError as exc:
        steps.append(note_step("操作终止", str(exc), ok=False))
        return False, steps
    except Exception as exc:  # 意外错误也要走 finally 恢复 timer
        steps.append(note_step("意外错误", f"{type(exc).__name__}: {exc}", ok=False))
        return False, steps
    finally:
        if flocked:
            flock.release()
            steps.append(note_step("释放 sync.lock", ""))
        if timer_stopped:
            rs = run_cmd(_sysctl(["start", "kkap-schedule.timer"]), timeout=30)
            steps.append({"title": "恢复 kkap-schedule.timer", **rs})
        REPO_OP_LOCK.release()


# ──────────────────────────── 各 mutate（在 repo_op 的 pull 之后执行） ────────────────────────────

def mutate_set_current(sem: str):
    """把选中学期的 meta.json isCurrent=true、其余 false。正则原位替换保持文件格式。"""
    def mutate(steps: list[dict], _created_paths: list[str]) -> None:  # 只改既有 meta.json，不新建文件
        changed: list[str] = []
        found = False
        for meta_path in sorted(globmod.glob(os.path.join(semesters_dir(), "*", "meta.json"))):
            label = os.path.basename(os.path.dirname(meta_path))
            want = label == sem
            found = found or want
            with open(meta_path, encoding="utf-8") as fh:
                text = fh.read()
            m = re.search(r'("isCurrent"\s*:\s*)(true|false)', text)
            if m:
                cur = m.group(2) == "true"
                if cur == want:
                    continue
                new_text = text[: m.start(2)] + ("true" if want else "false") + text[m.end(2):]
            else:  # 没有该字段：json round-trip 补写（缩进 2、保留中文）
                data = json.loads(text)
                data["isCurrent"] = want
                new_text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
            with open(meta_path, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(new_text)
            changed.append(f"{label} → isCurrent={str(want).lower()}")
        if not found:
            raise AdminError(f"学期目录不存在：{sem}")
        text = "；".join(changed) if changed else "已是目标状态，无文件变化"
        steps.append(note_step("更新 meta.json isCurrent", text))
    return mutate


def parse_build_config_form(form: dict) -> dict:
    """服务端校验 /semester 的 build_config 表单；不过闸直接 AdminError（不动 timer）。"""
    tests_raw = str(form.get("testSemesters", ""))
    tests = [t for t in re.split(r"[\s,，、]+", tests_raw.strip()) if t]
    for t in tests:
        if not SEM_RE.fullmatch(t):
            raise AdminError(f"testSemesters 含非法学期：{t!r}（应为 YYYY-03 / YYYY-09）")
    mirror_raw = str(form.get("mirrorSemesters", "")).strip() or "{}"
    try:
        mirror = json.loads(mirror_raw)
    except ValueError as exc:
        raise AdminError(f"mirrorSemesters 不是合法 JSON：{exc}")
    if not isinstance(mirror, dict):
        raise AdminError("mirrorSemesters 应为对象 {镜像来源学期: [克隆出的目标学期...]}")
    for k, v in mirror.items():
        if not (isinstance(k, str) and SEM_RE.fullmatch(k)):
            raise AdminError(f"mirrorSemesters 键非法：{k!r}")
        if not (isinstance(v, list) and all(isinstance(x, str) and SEM_RE.fullmatch(x) for x in v)):
            raise AdminError(f"mirrorSemesters[{k!r}] 应为学期字符串数组")
    live_sem = str(form.get("liveEnrollmentSemester", "")).strip()
    if live_sem and not SEM_RE.fullmatch(live_sem):
        raise AdminError(f"liveEnrollmentSemester 非法：{live_sem!r}")
    flags: dict[str, bool] = {}
    for key, val in form.items():
        if key.startswith("flag__"):
            if val not in ("true", "false"):
                raise AdminError(f"featureFlags.{key[6:]} 应为 true/false")
            flags[key[6:]] = val == "true"
    return {"testSemesters": tests, "mirrorSemesters": mirror,
            "liveEnrollmentSemester": live_sem, "featureFlags": flags}


def mutate_build_config(parsed: dict):
    def mutate(steps: list[dict], created_paths: list[str]) -> None:
        path = build_config_path()
        cfg: dict = {}
        created = not os.path.exists(path)
        if not created:
            with open(path, encoding="utf-8") as fh:
                loaded = json.load(fh)
            if not isinstance(loaded, dict):
                raise AdminError("build_config.json 顶层不是对象，拒绝覆盖")
            cfg = loaded
        cfg["testSemesters"] = parsed["testSemesters"]
        cfg["mirrorSemesters"] = parsed["mirrorSemesters"]
        # 留空 = 关闭实时人数轮询：写入空串保留键（build_data / 前端放行 ""），不再删除键
        cfg["liveEnrollmentSemester"] = parsed["liveEnrollmentSemester"]
        if parsed["featureFlags"]:
            ff = cfg.get("featureFlags")
            ff = dict(ff) if isinstance(ff, dict) else {}
            for name, val in parsed["featureFlags"].items():
                if name in ff:  # 只更新既有旗标；新增旗标走代码评审
                    ff[name] = val
            cfg["featureFlags"] = ff
        if created:
            created_paths.append(path)  # 写盘前登记：即使写入中途失败，回滚也能清掉半成品
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")
        verb = "创建" if created else "更新"
        steps.append(note_step(f"{verb} data/build_config.json",
                               json.dumps(cfg, ensure_ascii=False, indent=2)))
    return mutate


# ──────────────────────────── Cloudflare Pages API（可选 requests） ────────────────────────────

def cf_ready() -> bool:
    return requests is not None and bool(CF_ACCOUNT_ID) and bool(CF_API_TOKEN)


def cf_project_url() -> str:
    return (f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}"
            f"/pages/projects/{CF_PAGES_PROJECT}")


def cf_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {CF_API_TOKEN}"}


# ──────────────────────────── HTML 渲染 ────────────────────────────

esc = lambda s: html.escape(str(s), quote=True)  # noqa: E731 - 全文统一的转义入口

CSS = """
body{font-family:system-ui,'PingFang SC','Microsoft YaHei',sans-serif;margin:0;background:#f5f6f8;color:#1f2937}
nav{background:#7f1d1d;color:#fff;padding:10px 16px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
nav .brand{font-weight:700;margin-right:6px}
nav a{color:#fecaca;text-decoration:none;font-size:14px}
nav a.on{color:#fff;font-weight:700;border-bottom:2px solid #fff;padding-bottom:2px}
nav form{margin-left:auto}
main{max-width:980px;margin:20px auto;padding:0 16px}
h2{font-size:20px;margin:4px 0 14px}h3{font-size:16px;margin:0 0 10px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px}
table{border-collapse:collapse;width:100%;margin:8px 0}
td,th{border:1px solid #e5e7eb;padding:6px 8px;text-align:left;font-size:13px;vertical-align:top}
th{background:#f9fafb}
.badge{display:inline-block;padding:1px 8px;border-radius:9999px;font-size:12px}
.b-ok{background:#dcfce7;color:#166534}.b-bad{background:#fee2e2;color:#991b1b}.b-mut{background:#e5e7eb;color:#374151}
.warnbar{background:#fef3c7;border:1px solid #f59e0b;color:#92400e;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:14px}
.errbar{background:#fee2e2;border:1px solid #dc2626;color:#991b1b;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:14px}
.okbar{background:#dcfce7;border:1px solid #16a34a;color:#166534;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:14px}
pre{background:#111827;color:#e5e7eb;padding:10px;border-radius:6px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-all;margin:6px 0}
input[type=text],input[type=password],select,textarea{border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;font-size:14px;box-sizing:border-box}
textarea{width:100%;font-family:ui-monospace,Consolas,monospace}
button{background:#7f1d1d;color:#fff;border:0;border-radius:6px;padding:7px 14px;font-size:14px;cursor:pointer}
button.secondary{background:#4b5563}
.small{color:#6b7280;font-size:12px}
.field{margin:10px 0}
.field label{display:block;font-size:13px;font-weight:600;margin-bottom:3px}
.field .cur{color:#6b7280;font-size:12px;margin-left:6px;font-weight:400}
.kv{font-family:ui-monospace,Consolas,monospace;font-size:13px}
.step{border:1px solid #e5e7eb;border-radius:6px;padding:8px 10px;margin:8px 0}
.step .t{font-weight:600;font-size:14px}
"""

NAV = [
    ("/", "总览"),
    ("/semester", "学期管理"),
    ("/student-import", "学号导入"),
    ("/ai", "AI · Cloudflare"),
    ("/services", "服务"),
    ("/credentials", "凭据"),
    ("/logs", "日志"),
]


def csrf_input(sess: dict) -> str:
    return f"<input type='hidden' name='csrf' value='{esc(sess['csrf'])}'>"


def layout(title: str, body: str, active: str = "", sess: dict | None = None) -> str:
    links = ""
    for href, label in NAV:
        cls = " class='on'" if href == active else ""
        links += f"<a href='{href}'{cls}>{esc(label)}</a>"
    logout = ""
    if sess is not None:
        logout = (f"<form method='post' action='/logout'>{csrf_input(sess)}"
                  f"<button class='secondary'>退出</button></form>")
    envnote = ""
    if not HAVE_FCNTL or not HAVE_SYSTEMCTL:
        envnote = ("<p class='small'>提示：本机缺 fcntl/systemctl（Windows 冒烟环境）——"
                   "文件锁与 systemd 相关功能仅在 VPS 生效。</p>")
    return (f"<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>"
            f"<meta name='viewport' content='width=device-width,initial-scale=1'>"
            f"<title>{esc(title)} · JXNU 管理面板</title><style>{CSS}</style></head><body>"
            f"<nav><span class='brand'>JXNU选课PLUS · 管理面板</span>{links}{logout}</nav>"
            f"<main><h2>{esc(title)}</h2>{envnote}{body}</main></body></html>")


def card(title: str, inner: str) -> str:
    return f"<div class='card'><h3>{esc(title)}</h3>{inner}</div>"


def steps_html(steps: list[dict]) -> str:
    parts = []
    for s in steps:
        if s.get("ok"):
            badge = "<span class='badge b-ok'>OK</span>"
        else:
            badge = "<span class='badge b-bad'>失败</span>"
        body = ""
        if s.get("argv"):
            cmd = " ".join(str(a) for a in s["argv"])
            body += f"<div class='small kv'>$ {esc(cmd)}（rc={esc(s['rc'])}）</div>"
        if s.get("out"):
            body += f"<pre>{esc(s['out'])}</pre>"
        if s.get("err"):
            body += f"<pre>{esc(s['err'])}</pre>"
        parts.append(f"<div class='step'><div class='t'>{badge} {esc(s['title'])}</div>{body}</div>")
    return "".join(parts)


def restart_form(sess: dict, unit: str, label: str) -> str:
    return (f"<form method='post' action='/action/restart' style='display:inline-block;margin:2px 6px 2px 0'>"
            f"{csrf_input(sess)}<input type='hidden' name='unit' value='{esc(unit)}'>"
            f"<button class='secondary'>{esc(label)}</button></form>")


def env_field_html(key: str, current: dict[str, str], input_type: str = "text") -> str:
    cur = current.get(key, "")
    shown = mask_value(key, cur) if cur else "(未设置)"
    hint = ENV_FIELD_HINTS.get(key, "")
    itype = "password" if SENSITIVE_KEY_RE.search(key) else input_type
    return (f"<div class='field'><label>{esc(key)}"
            f"<span class='cur'>当前：{esc(shown)}</span></label>"
            f"<input type='{itype}' name='{esc(key)}' value='' placeholder='留空 = 不修改' style='width:60%'>"
            f"<div class='small'>{esc(hint)}</div></div>")


def env_form_html(sess: dict, file_key: str, keys: list[str], note: str = "") -> str:
    spec = ENV_SPECS[file_key]
    current = read_env_file(spec["path"])
    exists = os.path.exists(spec["path"])
    head = f"<p class='small kv'>{esc(spec['path'])}{'' if exists else '（文件不存在，保存将创建）'}</p>"
    fields = "".join(env_field_html(k, current) for k in keys)
    note_html = f"<div class='warnbar'>{note}</div>" if note else ""
    return (f"{head}{note_html}<form method='post' action='/action/save-env'>{csrf_input(sess)}"
            f"<input type='hidden' name='file' value='{esc(file_key)}'>{fields}"
            f"<button>保存 {esc(file_key)}.env</button>"
            f"<span class='small'> 留空的字段一律不修改；写回后自动 chmod 600。</span></form>")


# ──────────────────────────── 页面 ────────────────────────────

def page_login(error: str = "") -> str:
    err = f"<div class='errbar'>{esc(error)}</div>" if error else ""
    return (f"<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>"
            f"<meta name='viewport' content='width=device-width,initial-scale=1'>"
            f"<title>登录 · JXNU 管理面板</title><style>{CSS}</style></head><body>"
            f"<main style='max-width:380px;margin-top:12vh'><div class='card'>"
            f"<h3>JXNU选课PLUS · 管理面板</h3>"
            f"<p class='small'>内网面板：请经 SSH 隧道访问（详见 deploy/README.md）。</p>{err}"
            f"<form method='post' action='/login'>"
            f"<input type='password' name='password' placeholder='ADMIN_PASSWORD' autofocus style='width:100%'>"
            f"<button style='margin-top:10px;width:100%'>登录</button></form>"
            f"</div></main></body></html>")


def page_overview(sess: dict) -> str:
    body = ""
    # 学期旋钮一致性警告
    knob_rows, core = semester_knobs()
    distinct = sorted(set(core))
    if len(distinct) > 1:
        body += (f"<div class='warnbar'><b>学期旋钮不一致</b>：isCurrent / SYNC_SEM / "
                 f"KKAP_SEMESTER / liveEnrollmentSemester 中出现了多个值：{esc('、'.join(distinct))}。"
                 f"请到「学期管理」页统一。</div>")

    # 服务状态
    if HAVE_SYSTEMCTL:
        rows = ""
        for unit, desc in [
            ("kkap-realtime.service", "实时人数快照"),
            ("jxnu-live.service", "实时课表（学号导入上游）"),
            ("kkap-schedule.timer", "每小时数据同步定时器"),
            ("jxnu-admin.service", "管理面板（本服务）"),
        ]:
            r = run_cmd(_sysctl(["is-active", unit]), timeout=10)
            state = (r["out"] or r["err"]).strip() or "unknown"
            cls = "b-ok" if state == "active" else "b-bad"
            rows += (f"<tr><td class='kv'>{esc(unit)}</td><td>{esc(desc)}</td>"
                     f"<td><span class='badge {cls}'>{esc(state)}</span></td></tr>")
        timer_line = "(未找到 kkap-schedule.timer 行)"
        rt = run_cmd(_sysctl(["list-timers", "--all", "--no-pager"]), timeout=10)
        for ln in rt["out"].splitlines():
            if "kkap-schedule.timer" in ln:
                timer_line = ln.strip()
                break
        body += card("服务状态", f"<table><tr><th>单元</th><th>说明</th><th>状态</th></tr>{rows}</table>"
                                f"<p class='small kv'>下次触发：{esc(timer_line)}</p>")
    else:
        body += card("服务状态", "<p class='small'>本机不可用（无 systemctl）。生产 VPS 上为 systemd --user 单元。</p>")

    # git
    rg = run_cmd(_git(["log", "--oneline", "-1"]), timeout=15, cwd=REPO_DIR)
    git_line = (rg["out"] or rg["err"]).strip() or "(无输出)"
    body += card("仓库最新提交", f"<p class='kv'>{esc(git_line)}</p><p class='small kv'>{esc(REPO_DIR)}</p>")

    # 六个学期旋钮
    krows = "".join(f"<tr><td>{esc(name)}</td><td class='kv'>{esc(val)}</td></tr>" for name, val in knob_rows)
    body += card("学期旋钮汇总", f"<table><tr><th>旋钮</th><th>当前值</th></tr>{krows}</table>"
                               f"<p class='small'>前往「学期管理」页修改。</p>")
    return layout("总览", body, "/", sess)


def page_semester(sess: dict) -> str:
    body = ""
    sems = list_semesters()
    # 1) isCurrent
    radios = ""
    for label, cur in sems:
        checked = " checked" if cur else ""
        tag = "（当前）" if cur else ""
        radios += (f"<label style='display:block;margin:4px 0'>"
                   f"<input type='radio' name='sem' value='{esc(label)}'{checked}> "
                   f"<span class='kv'>{esc(label)}</span>{esc(tag)}</label>")
    if not radios:
        radios = "<p class='small'>data/semesters/ 下没有可用学期目录。</p>"
    body += card("当前学期（meta.json isCurrent）",
                 f"<p class='small'>决定 public/courses.json 的预选目录来自哪个学期。"
                 f"提交后走 repo_op：停 timer → git pull → 改文件 → build_data.py → push，约需数分钟，请勿重复提交。</p>"
                 f"<form method='post' action='/action/set-current-semester'>{csrf_input(sess)}{radios}"
                 f"<button>设为当前学期并重建推送</button></form>")

    # 2) build_config.json
    cfg, cfg_err = read_build_config()
    tests_val = "" if cfg is None else " ".join(cfg.get("testSemesters") or [])
    mirror_val = "{}" if cfg is None else json.dumps(cfg.get("mirrorSemesters") or {}, ensure_ascii=False)
    live_val = "" if cfg is None else str(cfg.get("liveEnrollmentSemester") or "")
    flags = {} if cfg is None else (cfg.get("featureFlags") or {})
    flags_html = ""
    if isinstance(flags, dict) and flags:
        for name, val in flags.items():
            t_sel = " selected" if bool(val) else ""
            f_sel = "" if bool(val) else " selected"
            flags_html += (f"<div class='field'><label>featureFlags.{esc(name)}</label>"
                           f"<select name='flag__{esc(name)}'>"
                           f"<option value='true'{t_sel}>true</option>"
                           f"<option value='false'{f_sel}>false</option></select></div>")
    else:
        flags_html = "<p class='small'>当前没有 featureFlags 键（新增旗标请走代码，不在面板加）。</p>"
    missing_note = ""
    if cfg is None:
        missing_note = (f"<div class='warnbar'>data/build_config.json 当前{esc(cfg_err or '')}。"
                        f"保存将创建该文件——需要 build_data.py 已支持读取它（并行开发中），否则保存了也不生效。</div>")
    body += card("构建配置（data/build_config.json）",
                 missing_note +
                 f"<form method='post' action='/action/save-build-config'>{csrf_input(sess)}"
                 f"<div class='field'><label>testSemesters<span class='cur'>空格/逗号分隔，正选侧显示「（测试）」后缀</span></label>"
                 f"<input type='text' name='testSemesters' value='{esc(tests_val)}' style='width:60%'></div>"
                 f"<div class='field'><label>mirrorSemesters<span class='cur'>JSON 对象 {{镜像来源学期: [克隆出的目标学期...]}}，"
                 f"如 {{\"2026-09\":[\"2025-09\"]}} = 把 2026-09 的数据克隆成 2025-09 标签</span></label>"
                 f"<textarea name='mirrorSemesters' rows='3'>{esc(mirror_val)}</textarea></div>"
                 f"<div class='field'><label>liveEnrollmentSemester<span class='cur'>实时人数挂到哪个学期；留空 = 关闭实时人数轮询</span></label>"
                 f"<input type='text' name='liveEnrollmentSemester' value='{esc(live_val)}' style='width:30%' placeholder='YYYY-03 / YYYY-09'></div>"
                 f"{flags_html}"
                 f"<button>保存并重建推送</button>"
                 f"<span class='small'> 同样走 repo_op（build + push）。</span></form>")

    # 3) SYNC_SEM / 4) KKAP_SEMESTER 快捷编辑（env 文件不在仓库内，不走 repo_op）
    body += card("每小时同步目标学期（sync.env SYNC_SEM）",
                 env_form_html(sess, "sync", ["SYNC_SEM"]))
    body += card("实时人数学期（kkap.env KKAP_SEMESTER）",
                 env_form_html(sess, "kkap", ["KKAP_SEMESTER"],
                               note="改完需重启 kkap-realtime 服务生效（保存结果页有一键重启按钮）。"))
    return layout("学期管理", body, "/semester", sess)


def page_student_import(sess: dict) -> str:
    body = card(
        "规划学期覆盖（live.env LIVE_PLANNING_TERM_OVERRIDE）",
        "<p>学号一键导入时，实时课表服务需要判断「下学期 / 规划学期」。默认自动取教务系统当前学期推导；"
        "寒暑假窗口期教务默认值可能滞后或超前，此时用该键手工覆盖。</p>"
        "<ul class='small'><li>留空并勾选「清除」= 恢复自动推导</li>"
        "<li>格式示例：<span class='kv'>26-27第1学期</span>（教务的学年学期写法）</li>"
        "<li>改完需重启 jxnu-live 服务生效（保存结果页有一键重启）。</li></ul>"
        + _override_form(sess))
    return layout("学号导入", body, "/student-import", sess)


def _override_form(sess: dict) -> str:
    current = read_env_file(LIVE_ENV_PATH)
    cur = current.get("LIVE_PLANNING_TERM_OVERRIDE", "")
    shown = cur if cur else "(未设置 = 自动)"
    return (f"<form method='post' action='/action/save-env'>{csrf_input(sess)}"
            f"<input type='hidden' name='file' value='live'>"
            f"<div class='field'><label>LIVE_PLANNING_TERM_OVERRIDE"
            f"<span class='cur'>当前：{esc(shown)}</span></label>"
            f"<input type='text' name='LIVE_PLANNING_TERM_OVERRIDE' value='' placeholder='如 26-27第1学期；留空=不修改' style='width:40%'>"
            f"<label style='font-weight:400;display:inline-block;margin-left:10px'>"
            f"<input type='checkbox' name='LIVE_PLANNING_TERM_OVERRIDE__clear' value='1'> 清除该键（恢复自动）</label></div>"
            f"<button>保存</button></form>")


def page_ai(sess: dict) -> str:
    body = ""
    if requests is None:
        body += card("requests 不可用",
                     "<p>本机 Python 没有 requests，无法调 Cloudflare API。两个选择：</p>"
                     "<ul><li>VPS 上系统级安装：<span class='kv'>sudo apt install python3-requests</span>"
                     "（或 pip 装 requests）后重启 jxnu-admin</li>"
                     "<li>直接去 Cloudflare dashboard 手改 Pages 项目的环境变量</li></ul>")
        return layout("AI · Cloudflare", body, "/ai", sess)
    if not (CF_ACCOUNT_ID and CF_API_TOKEN):
        body += card("未配置 Cloudflare API 凭据",
                     "<p>需要在 <span class='kv'>~/apps/jxnu-admin/admin.env</span> 填入 "
                     "<span class='kv'>CF_ACCOUNT_ID</span> 与 <span class='kv'>CF_API_TOKEN</span>，"
                     "然后重启 jxnu-admin。</p>"
                     "<p><b>Token 创建指引</b>：dash.cloudflare.com → 右上角 My Profile → API Tokens → "
                     "Create Token → Create Custom Token：</p>"
                     "<ul><li>Permissions：<span class='kv'>Account / Cloudflare Pages / Edit</span></li>"
                     "<li>Account Resources：选你的账号</li>"
                     "<li>Account ID 在 dashboard 任意域概览页右侧栏可复制</li></ul>")
        return layout("AI · Cloudflare", body, "/ai", sess)

    # 读取现有 env_vars
    try:
        resp = requests.get(cf_project_url(), headers=cf_headers(), timeout=15)
        data = resp.json()
    except Exception as exc:
        body += card("读取 Pages 项目失败", f"<pre>{esc(f'{type(exc).__name__}: {exc}')}</pre>")
        return layout("AI · Cloudflare", body, "/ai", sess)
    if not data.get("success"):
        body += card("Cloudflare API 报错", f"<pre>{esc(json.dumps(data.get('errors'), ensure_ascii=False, indent=2))}</pre>")
        return layout("AI · Cloudflare", body, "/ai", sess)
    env_vars = (((data.get("result") or {}).get("deployment_configs") or {})
                .get("production") or {}).get("env_vars") or {}
    rows = ""
    for name in sorted(env_vars):
        item = env_vars[name] or {}
        typ = item.get("type") or "plain_text"
        if typ == "secret_text":
            val_html = "<span class='badge b-mut'>已设置（secret）</span>"
        else:
            val_html = f"<span class='kv'>{esc(item.get('value') or '')}</span>"
        rows += f"<tr><td class='kv'>{esc(name)}</td><td>{esc(typ)}</td><td>{val_html}</td></tr>"
    body += card(f"生产环境变量（{CF_PAGES_PROJECT} / production）",
                 f"<table><tr><th>键</th><th>类型</th><th>值</th></tr>{rows or '<tr><td colspan=3>（空）</td></tr>'}</table>")

    # 保存表单
    fields = ""
    for key in CF_PLAIN_KEYS:
        hint = "整数" if key in CF_INT_KEYS else "明文（plain_text）"
        fields += (f"<div class='field'><label>{esc(key)}<span class='cur'>{esc(hint)}；留空=不动</span></label>"
                   f"<input type='text' name='{esc(key)}' value='' style='width:60%'></div>")
    for key in CF_SECRET_KEYS:
        fields += (f"<div class='field'><label>{esc(key)}<span class='cur'>secret_text；留空=不动</span></label>"
                   f"<input type='password' name='{esc(key)}' value='' style='width:60%'></div>")
    body += card("修改环境变量",
                 "<div class='warnbar'><b>LIVE_SECRET 必须两侧同步</b>：这里改的是 Cloudflare 侧；"
                 "VPS 侧在「凭据」页的 live.env。两侧不一致时学号实时导入会回落 D1 快照。</div>"
                 f"<form method='post' action='/action/cf-save'>{csrf_input(sess)}{fields}"
                 f"<button>PATCH 到 Cloudflare</button>"
                 f"<span class='small'> 改完需触发新部署才生效（下方按钮）。</span></form>")
    body += card("触发新部署",
                 f"<form method='post' action='/action/cf-redeploy'>{csrf_input(sess)}"
                 f"<button class='secondary'>POST /deployments（重新部署 production）</button></form>")
    return layout("AI · Cloudflare", body, "/ai", sess)


def page_services(sess: dict) -> str:
    body = ""
    if HAVE_SYSTEMCTL:
        rows = ""
        for unit_key, unit, desc in [
            ("kkap-realtime", "kkap-realtime.service", "实时人数快照"),
            ("jxnu-live", "jxnu-live.service", "实时课表（学号导入上游）"),
            ("jxnu-admin", "jxnu-admin.service", "管理面板（重启自身：先返回响应再延迟 1s 执行）"),
        ]:
            r = run_cmd(_sysctl(["is-active", unit]), timeout=10)
            state = (r["out"] or r["err"]).strip() or "unknown"
            cls = "b-ok" if state == "active" else "b-bad"
            rows += (f"<tr><td class='kv'>{esc(unit)}</td><td>{esc(desc)}</td>"
                     f"<td><span class='badge {cls}'>{esc(state)}</span></td>"
                     f"<td>{restart_form(sess, unit_key, '重启')}</td></tr>")
        body += card("常驻服务", f"<table><tr><th>单元</th><th>说明</th><th>状态</th><th>操作</th></tr>{rows}</table>")
    else:
        body += card("常驻服务", "<p class='small'>本机不可用（无 systemctl）。</p>")

    body += card("每小时同步（kkap-schedule）",
                 f"<p class='small'>oneshot 异步启动，进度看 <a href='/logs?unit=kkap-schedule'>日志页</a>。</p>"
                 f"<form method='post' action='/action/start-sync' style='display:inline-block;margin-right:8px'>"
                 f"{csrf_input(sess)}<button>立即跑一次同步</button></form>"
                 f"<form method='post' action='/action/probe-capacity' style='display:inline-block'>"
                 f"{csrf_input(sess)}<button class='secondary'>探测容量阶段（crawl_capacity --probe 3，≤180s）</button></form>")

    body += card("kkap.env 配置", env_form_html(
        sess, "kkap", ["KKAP_SEMESTER", "KKAP_REFRESH_SECONDS", "KKAP_ALLOWED_ORIGINS"],
        note="改完需重启 kkap-realtime 生效（保存结果页有一键重启按钮）。"))
    return layout("服务", body, "/services", sess)


def page_credentials(sess: dict) -> str:
    body = card("sync.env（每小时同步 / 容量爬取凭据）", env_form_html(
        sess, "sync",
        ["XK_USERNAME", "XK_PASSWORD", "XK_STEP",
         "SYNC_MIN_SECTIONS", "SYNC_MIN_CAPACITY_VISIBLE", "SYNC_MIN_ROWS"],
        note="SYNC_SEM 在「学期管理」页改。sync.env 每次同步时现读，保存即生效、无需重启。"))
    body += card("live.env（实时课表服务凭据）", env_form_html(
        sess, "live",
        ["XK_USERNAME", "XK_PASSWORD", "LIVE_SECRET", "LIVE_CACHE_TTL"],
        note="<b>LIVE_SECRET 警告</b>：必须同步修改 Cloudflare 侧的 LIVE_SECRET"
             "（「AI · Cloudflare」页可改），否则学号实时导入将回落 D1 快照。"
             " 改完需重启 jxnu-live 生效。"))
    return layout("凭据", body, "/credentials", sess)


def page_logs(sess: dict, query: dict) -> str:
    unit = (query.get("unit") or ["kkap-schedule"])[0]
    if unit not in LOG_UNITS:
        unit = "kkap-schedule"
    try:
        lines = int((query.get("lines") or ["200"])[0])
    except ValueError:
        lines = 200
    lines = max(10, min(500, lines))

    opts = ""
    for u in LOG_UNITS:
        sel = " selected" if u == unit else ""
        opts += f"<option value='{esc(u)}'{sel}>{esc(u)}</option>"
    form = (f"<form method='get' action='/logs' style='margin-bottom:10px'>"
            f"<select name='unit'>{opts}</select> "
            f"<input type='text' name='lines' value='{lines}' style='width:70px'> 行（≤500） "
            f"<button>查看</button></form>")
    if HAVE_JOURNALCTL:
        r = run_cmd(["journalctl", "--user", "-u", f"{unit}.service", "-n", str(lines), "--no-pager"],
                    timeout=30)
        out = r["out"] or r["err"] or "(无输出)"
        content = f"<pre>{esc(out)}</pre>"
    else:
        content = "<p class='small'>本机不可用（无 journalctl）。生产 VPS 上可看各 systemd --user 单元日志。</p>"
    return layout("日志", card(f"journalctl --user -u {unit}.service -n {lines}", form + content),
                  "/logs", sess)


# ──────────────────────────── HTTP Handler ────────────────────────────

def make_handler():
    class Handler(BaseHTTPRequestHandler):
        server_version = "JXNU-Admin/1.0"

        def log_message(self, fmt: str, *args: object) -> None:
            print(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}")

        # ── 基础收发 ──
        def _send_html(self, doc: str, status: int = 200,
                       extra_headers: list[tuple[str, str]] | None = None) -> None:
            raw = doc.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Content-Security-Policy",
                             "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'")
            for k, v in (extra_headers or []):
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(raw)

        def _send_json(self, payload: dict, status: int = 200) -> None:
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)

        def _redirect(self, location: str, set_cookie: str | None = None) -> None:
            self.send_response(303)
            self.send_header("Location", location)
            if set_cookie:
                self.send_header("Set-Cookie", set_cookie)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _cookie_token(self) -> str | None:
            cookie = self.headers.get("Cookie") or ""
            m = re.search(rf"(?:^|;\s*){COOKIE_NAME}=([0-9a-f]{{64}})", cookie)
            return m.group(1) if m else None

        def _session(self) -> dict | None:
            return get_session(self._cookie_token())

        def _read_form(self) -> dict[str, str]:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 1_000_000:
                raise AdminError("请求体过大")
            raw = self.rfile.read(length).decode("utf-8", "replace") if length else ""
            return {k: v[0] for k, v in parse_qs(raw, keep_blank_values=True).items()}

        def _result_page(self, sess: dict, title: str, ok: bool, steps: list[dict],
                         extra: str = "", status: int = 200) -> None:
            bar = ("<div class='okbar'>操作完成</div>" if ok
                   else "<div class='errbar'>操作失败（见下方步骤输出）</div>")
            back = "<p><a href='/'>← 回总览</a></p>"
            self._send_html(layout(title, bar + steps_html(steps) + extra + back, "", sess), status)

        # ── GET ──
        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            try:
                parsed = urlparse(self.path)
                path = parsed.path.rstrip("/") or "/"
                query = parse_qs(parsed.query, keep_blank_values=True)
                if path == "/healthz":
                    self._send_json({"ok": True, "service": "jxnu-admin"})
                    return
                if path == "/favicon.ico":
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                sess = self._session()
                if path == "/login":
                    if sess:
                        self._redirect("/")
                    else:
                        self._send_html(page_login())
                    return
                if not sess:
                    self._redirect("/login")
                    return
                pages = {
                    "/": page_overview,
                    "/semester": page_semester,
                    "/student-import": page_student_import,
                    "/ai": page_ai,
                    "/services": page_services,
                    "/credentials": page_credentials,
                }
                if path in pages:
                    self._send_html(pages[path](sess))
                elif path == "/logs":
                    self._send_html(page_logs(sess, query))
                else:
                    self._send_html(layout("404", card("未找到页面", f"<p class='kv'>{esc(path)}</p>"),
                                           "", sess), 404)
            except Exception as exc:
                self._send_html(layout("错误", card("500", f"<pre>{esc(f'{type(exc).__name__}: {exc}')}</pre>")), 500)

        # ── POST ──
        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            try:
                path = urlparse(self.path).path.rstrip("/")
                form = self._read_form()
                if path == "/login":
                    self._post_login(form)
                    return
                sess = self._session()
                if not sess:
                    self._redirect("/login")
                    return
                tok = str(form.get("csrf", ""))
                if not (tok and hmac.compare_digest(tok.encode(), str(sess["csrf"]).encode())):
                    self._send_html(layout("拒绝", card("CSRF 校验失败", "<p>请回上一页重新提交。</p>"), "", sess), 403)
                    return
                if path == "/logout":
                    drop_session(self._cookie_token())
                    self._redirect("/login", set_cookie=f"{COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0")
                    return
                actions = {
                    "/action/set-current-semester": self._act_set_current,
                    "/action/save-build-config": self._act_save_build_config,
                    "/action/save-env": self._act_save_env,
                    "/action/restart": self._act_restart,
                    "/action/start-sync": self._act_start_sync,
                    "/action/probe-capacity": self._act_probe_capacity,
                    "/action/cf-save": self._act_cf_save,
                    "/action/cf-redeploy": self._act_cf_redeploy,
                }
                fn = actions.get(path)
                if fn is None:
                    self._send_html(layout("404", card("未知动作", f"<p class='kv'>{esc(path)}</p>"), "", sess), 404)
                    return
                try:
                    fn(sess, form)
                except AdminBusy:
                    self._send_html(layout("409 · 操作进行中",
                                           card("已有操作进行中",
                                                "<p>另一个仓库写操作正在执行（stop timer → build → push 全程互斥），请稍后重试。</p>"),
                                           "", sess), 409)
                except AdminError as exc:
                    self._result_page(sess, "参数校验失败", False, [note_step("校验", str(exc), ok=False)], status=400)
            except Exception as exc:
                self._send_html(layout("错误", card("500", f"<pre>{esc(f'{type(exc).__name__}: {exc}')}</pre>")), 500)

        # ── 动作实现 ──
        def _post_login(self, form: dict) -> None:
            ok, token, _sess = login_attempt(str(form.get("password", "")))
            if not ok:
                self._send_html(page_login("密码错误"), 401)
                return
            cookie = (f"{COOKIE_NAME}={token}; HttpOnly; SameSite=Strict; Path=/; "
                      f"Max-Age={SESSION_TTL}")
            self._redirect("/", set_cookie=cookie)

        def _act_set_current(self, sess: dict, form: dict) -> None:
            sem = str(form.get("sem", ""))
            labels = [label for label, _cur in list_semesters()]
            if sem not in labels:  # 白名单：只接受实际存在的学期目录
                raise AdminError(f"未知学期：{sem!r}（不在 data/semesters/ 下）")
            ok, steps = repo_op(f"当前学期切换为 {sem}", mutate_set_current(sem))
            self._result_page(sess, "设置当前学期", ok, steps)

        def _act_save_build_config(self, sess: dict, form: dict) -> None:
            parsed = parse_build_config_form(form)  # 先校验，不过闸不碰 timer
            ok, steps = repo_op("更新 build_config", mutate_build_config(parsed))
            self._result_page(sess, "保存构建配置", ok, steps)

        def _act_save_env(self, sess: dict, form: dict) -> None:
            file_key = str(form.get("file", ""))
            spec = ENV_SPECS.get(file_key)
            if spec is None:
                raise AdminError(f"未知 env 文件：{file_key!r}")
            updates: dict[str, str | None] = {}
            for key, validator in spec["keys"].items():
                if key == "LIVE_PLANNING_TERM_OVERRIDE" and form.get(f"{key}__clear"):
                    updates[key] = None  # 显式清除 → 删除该键
                    continue
                if key not in form:
                    continue  # 该表单没带这个字段 → 不动
                val = str(form[key]).strip()
                if not val:
                    continue  # 留空 = 不修改
                updates[key] = validator(val)
            if not updates:
                self._result_page(sess, "保存 env", True,
                                  [note_step("无变化", "所有字段留空，未做任何修改")])
                return
            write_env_updates(spec["path"], updates)
            shown = "、".join(f"{k}（已删除）" if v is None else k for k, v in updates.items())
            steps = [note_step(f"写入 {spec['path']}（chmod 600）", f"已更新键：{shown}")]
            extra = ""
            if spec["restart"]:
                extra = ("<div class='warnbar'>该服务读 env 只在启动时，改完需重启生效：" +
                         restart_form(sess, spec["restart"], f"重启 {spec['restart']}") + "</div>")
            if "LIVE_SECRET" in updates:
                extra += ("<div class='errbar'><b>LIVE_SECRET 已改</b>：必须同步修改 Cloudflare 侧 "
                          "LIVE_SECRET（<a href='/ai'>AI · Cloudflare</a> 页），否则学号实时导入将回落 D1 快照。</div>")
            self._result_page(sess, f"保存 {file_key}.env", True, steps, extra)

        def _act_restart(self, sess: dict, form: dict) -> None:
            unit = str(form.get("unit", ""))
            if unit not in RESTART_UNITS:  # 白名单：用户输入只作键选择
                raise AdminError(f"不允许重启的单元：{unit!r}")
            service = f"{unit}.service"
            if unit == "jxnu-admin":
                if REPO_OP_LOCK.locked():
                    # 有仓库操作进行中：重启自身会打断 build/push，finally 不执行 → timer 永久停摆
                    raise AdminBusy()
                # 重启自己：先把响应发出去，再延迟 1s 执行，避免连接被掐断
                threading.Timer(1.0, lambda: subprocess.run(
                    _sysctl(["restart", service]), shell=False, timeout=30,
                    capture_output=True)).start()
                self._result_page(sess, "重启管理面板", True,
                                  [note_step("已计划重启", "1 秒后执行 systemctl --user restart jxnu-admin；"
                                                        "面板会短暂中断，所有会话失效需重新登录。")])
                return
            steps: list[dict] = []
            r = run_step(steps, f"systemctl --user restart {service}",
                         _sysctl(["restart", service]), must=False, timeout=60)
            self._result_page(sess, f"重启 {unit}", r["ok"], steps)

        def _act_start_sync(self, sess: dict, form: dict) -> None:
            steps: list[dict] = []
            r = run_step(steps, "异步启动 kkap-schedule.service（oneshot）",
                         _sysctl(["start", "--no-block", "kkap-schedule.service"]),
                         must=False, timeout=30)
            extra = "<p>进度看 <a href='/logs?unit=kkap-schedule'>日志页（kkap-schedule）</a>。</p>"
            self._result_page(sess, "手动触发同步", r["ok"], steps, extra)

        def _act_probe_capacity(self, sess: dict, form: dict) -> None:
            # 剔除 ADMIN_PASSWORD/CF_*，再叠加 XK_USERNAME/XK_PASSWORD/XK_STEP
            env = child_env(read_env_file(SYNC_ENV_PATH))
            steps: list[dict] = []
            r = run_step(steps, "python3 tools/crawl_capacity.py --probe 3",
                         [PY, "tools/crawl_capacity.py", "--probe", "3"],
                         must=False, timeout=180, cwd=REPO_DIR, env=env)
            extra = ("<p class='small'>探针只测登录 + 当前阶段 + 前 3 门课；"
                     "若回显阶段与 sync.env 的 XK_STEP 不符，去「凭据」页改 XK_STEP。</p>")
            self._result_page(sess, "探测容量阶段", r["ok"], steps, extra)

        def _act_cf_save(self, sess: dict, form: dict) -> None:
            if requests is None or not cf_ready():
                raise AdminError("Cloudflare API 未就绪（requests 缺失或 CF_ACCOUNT_ID/CF_API_TOKEN 未配置）")
            env_vars: dict[str, dict] = {}
            for key in CF_PLAIN_KEYS + CF_SECRET_KEYS:
                val = str(form.get(key, "")).strip()
                if not val:
                    continue  # 留空的键跳过不动
                if key in CF_INT_KEYS:
                    val = v_int(0)(val)
                if "\n" in val or "\r" in val:
                    raise AdminError(f"{key} 不能含换行")
                typ = "secret_text" if key in CF_SECRET_KEYS else "plain_text"
                env_vars[key] = {"type": typ, "value": val}
            if not env_vars:
                self._result_page(sess, "Cloudflare 保存", True,
                                  [note_step("无变化", "所有字段留空，未调用 API")])
                return
            body = {"deployment_configs": {"production": {"env_vars": env_vars}}}
            steps: list[dict] = []
            try:
                resp = requests.patch(cf_project_url(), headers=cf_headers(), json=body, timeout=30)
                data = resp.json()
            except Exception as exc:
                steps.append(note_step("PATCH Pages 项目", f"{type(exc).__name__}: {exc}", ok=False))
                self._result_page(sess, "Cloudflare 保存", False, steps)
                return
            ok = bool(data.get("success"))
            detail = f"HTTP {resp.status_code}；已提交键：{'、'.join(sorted(env_vars))}"
            if not ok:
                detail += "\n" + json.dumps(data.get("errors"), ensure_ascii=False, indent=2)
            steps.append(note_step("PATCH Pages 项目 env_vars", detail, ok=ok))
            extra = ("<div class='warnbar'>环境变量改动需<b>触发新部署</b>才生效——"
                     "回 <a href='/ai'>AI · Cloudflare</a> 页点「POST /deployments」。</div>") if ok else ""
            self._result_page(sess, "Cloudflare 保存", ok, steps, extra)

        def _act_cf_redeploy(self, sess: dict, form: dict) -> None:
            if requests is None or not cf_ready():
                raise AdminError("Cloudflare API 未就绪（requests 缺失或 CF_ACCOUNT_ID/CF_API_TOKEN 未配置）")
            steps: list[dict] = []
            try:
                resp = requests.post(cf_project_url() + "/deployments", headers=cf_headers(), timeout=60)
                data = resp.json()
            except Exception as exc:
                steps.append(note_step("POST /deployments", f"{type(exc).__name__}: {exc}", ok=False))
                self._result_page(sess, "触发部署", False, steps)
                return
            ok = bool(data.get("success"))
            result = data.get("result") or {}
            detail = f"HTTP {resp.status_code}；deployment id: {result.get('id', '(未知)')}"
            if not ok:
                detail += "\n" + json.dumps(data.get("errors"), ensure_ascii=False, indent=2)
            steps.append(note_step("POST /deployments（production）", detail, ok=ok))
            self._result_page(sess, "触发部署", ok, steps)

    return Handler


# ──────────────────────────── main ────────────────────────────

def main() -> None:
    if not ADMIN_PASSWORD:
        sys.exit("需要 ADMIN_PASSWORD 环境变量（见 deploy/admin.env.example）")
    if BIND not in ("127.0.0.1", "localhost", "::1"):
        print(f"[warn] ADMIN_BIND={BIND} 不是回环地址——本面板设计为仅经 SSH 隧道访问，请确认防火墙")
    if requests is None:
        print("[warn] requests 不可用：/ai 页的 Cloudflare API 功能停用（页面有安装指引）")
    if not HAVE_FCNTL:
        print("[warn] fcntl 不可用（Windows 冒烟环境）：sync.lock 文件锁仅在 VPS 生效")
    if HAVE_SYSTEMCTL:
        # 自愈：上一进程若在 repo_op 中途被杀，kkap-schedule.timer 可能停着没恢复。
        # start 幂等——已在跑无副作用，停着则拉起。
        rt = run_cmd(_sysctl(["start", "kkap-schedule.timer"]), timeout=30)
        if not rt["ok"]:
            print(f"[warn] 自愈启动 kkap-schedule.timer 失败（rc={rt['rc']}）：{(rt['err'] or rt['out']).strip()}")

    server = ThreadingHTTPServer((BIND, PORT), make_handler())

    def stop(_signum: int, _frame: object) -> None:
        def graceful() -> None:
            # 等进行中的仓库操作收尾再关（停 timer → build → push 全程可达 10 分钟）：
            # 中途打断会跳过 repo_op 的 finally，kkap-schedule.timer 将永久停摆
            if REPO_OP_LOCK.acquire(blocking=True, timeout=660):
                REPO_OP_LOCK.release()
            else:
                print("[warn] 等待仓库操作结束超时（660s），继续关闭——kkap-schedule.timer 可能未恢复，需人工检查")
            server.shutdown()
        threading.Thread(target=graceful, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"jxnu-admin listening on {BIND}:{PORT}; repo={REPO_DIR}; "
          f"cf={'ready' if cf_ready() else 'off'}; systemctl={'yes' if HAVE_SYSTEMCTL else 'no'}")
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
