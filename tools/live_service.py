#!/usr/bin/env python3
"""
教务实时课表服务 —— CF Pages Function 的上游。收到学号 → 单次会话翻全学期 → 联表脱敏 → JSON。

照 kkap_service.py 的骨架：标准库 HTTP + 常驻会话。区别是这里带 CAS 登录态（jwc_schedule）。
凭据走 env（XK_USERNAME / XK_PASSWORD / LIVE_SECRET），本文件不含账号密码。

部署（照 ~/apps/jxnu-kkap 布局）：
  ~/apps/jxnu-live/live.env   XK_USERNAME/XK_PASSWORD/LIVE_SECRET/LIVE_BIND/LIVE_PORT/LIVE_CACHE_TTL
  ~/apps/jxnu-live/run-live.sh + systemd --user unit jxnu-live.service + Caddy 反代
master 数据读仓库 ~/better-jxnu-elective-system/data/master（kkap-schedule 每小时同步保鲜；mtime 变则热重载）。

安全/礼貌：
  - X-Live-Secret 头校验，否则 403（公网直连挡掉；只有 CF 函数持 secret）。
  - 全局 fetch 锁：对 jwc 串行（并发 1），顺带让重登录 single-flight。
  - per-sid TTL 缓存（默认 600s）吸收重复点击。
  - 姓名在 jwc_schedule.fetch_student 已剥（只留 className）。
"""

from __future__ import annotations

import hashlib
import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import requests

REPO = os.environ.get("LIVE_REPO", os.path.expanduser("~/better-jxnu-elective-system"))
# 优先用与本文件同目录的模块副本（~/apps/jxnu-live 部署形态），仓库 tools 作 dev 兜底。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.append(os.path.join(REPO, "tools"))
import jwc_schedule as J  # noqa: E402
import student_record_lib as L  # noqa: E402

MASTER_DIR = os.path.join(REPO, "data", "master")
requests.packages.urllib3.disable_warnings()  # type: ignore[attr-defined]


class Service:
    def __init__(self, cache_ttl: int) -> None:
        self.cache_ttl = cache_ttl
        self.session = None
        self.fetch_lock = threading.Lock()   # 对 jwc 串行 + 重登录 single-flight
        self.cache: dict[str, tuple[float, dict]] = {}
        self.cache_lock = threading.Lock()
        self.ctx = None
        self.ctx_mtime = 0.0
        self.started_at = time.time()

    def ensure_ctx(self):
        """master mtime 变了就热重载（kkap-schedule 每小时可能更新 data/master）。"""
        cj = os.path.join(MASTER_DIR, "courses.json")
        mt = os.path.getmtime(cj)
        if self.ctx is None or mt > self.ctx_mtime:
            self.ctx = L.load_master_ctx(MASTER_DIR)
            self.ctx_mtime = mt
        return self.ctx

    def ensure_session(self):
        if self.session is None or not J.is_authed(self.session):
            self.session = J.make_session()
            J.login(self.session, os.environ["XK_USERNAME"], os.environ["XK_PASSWORD"])

    def get_record(self, sid: str) -> dict:
        now = time.time()
        with self.cache_lock:
            hit = self.cache.get(sid)
            if hit and hit[0] > now:
                return hit[1]

        with self.fetch_lock:
            # 双检：可能有别的请求刚填好缓存。
            with self.cache_lock:
                hit = self.cache.get(sid)
                if hit and hit[0] > time.time():
                    return hit[1]
            self.ensure_session()
            ctx = self.ensure_ctx()
            agg = J.fetch_student(self.session, sid)
            result = L.build_record(
                sid, agg["class_name"], agg["courses_by_cno"],
                agg["latest_term"], agg["schedule_items"], agg["no_schedule"], ctx,
            )
            row = result["row"]
            payload = {
                "source": "live",
                # CF 写回 D1 用（列：class_name/plan_key/total_earned/taken_count）。
                "row": {
                    "className": row["class_name"],
                    "planKey": row["plan_key"],
                    "totalEarned": row["total_earned"],
                    "takenCount": row["taken_count"],
                },
                # 完整 StudentRecord（== D1 record_json 形状）；CF 直接透传给前端 + JSON.stringify 入库。
                "record": result["record"],
            }
            with self.cache_lock:
                self.cache[sid] = (time.time() + self.cache_ttl, payload)
            return payload

    def health(self) -> dict:
        return {
            "ok": True,
            "authed": bool(self.session is not None and J.is_authed(self.session)),
            "cacheSize": len(self.cache),
            "ctxLoaded": self.ctx is not None,
            "uptimeSec": round(time.time() - self.started_at, 1),
        }


def make_handler(service: Service, secret: str):
    class Handler(BaseHTTPRequestHandler):
        server_version = "JXNU-Live/1.0"

        def log_message(self, fmt: str, *args: object) -> None:
            print(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}")

        def _send(self, payload: dict, status: int = 200) -> None:
            raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/") or "/"

            if path == "/healthz":
                self._send(service.health())
                return

            if path == "/student-record":
                # secret 门禁：公网直连挡掉。
                if secret and self.headers.get("X-Live-Secret") != secret:
                    self._send({"error": "forbidden"}, 403)
                    return
                sid = (parse_qs(parsed.query).get("sid", [""])[0] or "").strip()
                if not sid or not sid.isdigit():
                    self._send({"error": "sid required"}, 400)
                    return
                try:
                    self._send(service.get_record(sid))
                except Exception as exc:  # 抓取/登录失败 → 502，让 CF 回落 D1。
                    print(f"[error] sid={sid}: {type(exc).__name__}: {exc}")
                    self._send({"error": f"{type(exc).__name__}: {exc}"}, 502)
                return

            self._send({"service": "jxnu-live", "endpoints": ["/healthz", "/student-record?sid="]}, 404)

    return Handler


def main() -> None:
    bind = os.environ.get("LIVE_BIND", "127.0.0.1")
    port = int(os.environ.get("LIVE_PORT", "8788"))
    secret = os.environ.get("LIVE_SECRET", "")
    cache_ttl = int(os.environ.get("LIVE_CACHE_TTL", "600"))
    if not os.environ.get("XK_USERNAME") or not os.environ.get("XK_PASSWORD"):
        sys.exit("需要 XK_USERNAME / XK_PASSWORD 环境变量")
    if not secret:
        print("[warn] LIVE_SECRET 为空：端点未鉴权（仅限本机测试）")

    service = Service(cache_ttl)
    server = ThreadingHTTPServer((bind, port), make_handler(service, secret))

    def stop(_signum: int, _frame: object) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"jxnu-live listening on {bind}:{port}; cacheTtl={cache_ttl}s; secret={'set' if secret else 'NONE'}")
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
