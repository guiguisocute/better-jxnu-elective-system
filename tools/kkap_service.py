#!/usr/bin/env python3
"""Small dependency-free HTTP service for live JXNU enrollment snapshots."""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import signal
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

from kkap_monitor import build_snapshot, utc_now


def iso_after(seconds: float) -> str:
    value = datetime.now(timezone.utc) + timedelta(seconds=max(0, seconds))
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


class SnapshotStore:
    def __init__(self, semester: str, interval: int) -> None:
        self.semester = semester
        self.interval = interval
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.snapshot: dict[str, Any] | None = None
        self.last_attempt_at: str | None = None
        self.last_error: str | None = None
        self.next_refresh_at = utc_now()
        self.refreshing = False

    def public_state(self, include_items: bool) -> dict[str, Any]:
        with self.lock:
            base: dict[str, Any] = {
                "ok": self.snapshot is not None,
                "refreshing": self.refreshing,
                "lastAttemptAt": self.last_attempt_at,
                "nextRefreshAt": self.next_refresh_at,
                "refreshIntervalMs": self.interval * 1000,
                "error": self.last_error,
            }
            if self.snapshot:
                base.update(self.snapshot if include_items else {
                    key: value for key, value in self.snapshot.items() if key != "items"
                })
            return base

    def run(self) -> None:
        while not self.stop_event.is_set():
            started = time.monotonic()
            with self.lock:
                self.refreshing = True
                self.last_attempt_at = utc_now()
                self.next_refresh_at = iso_after(self.interval)
            try:
                snapshot = build_snapshot(self.semester)
                with self.lock:
                    self.snapshot = snapshot
                    self.last_error = None
            except Exception as exc:  # keep serving the last good snapshot
                with self.lock:
                    self.last_error = f"{type(exc).__name__}: {exc}"
            finally:
                elapsed = time.monotonic() - started
                wait_for = max(0.0, self.interval - elapsed)
                with self.lock:
                    self.refreshing = False
                    self.next_refresh_at = iso_after(wait_for)
                self.stop_event.wait(wait_for)


def make_handler(store: SnapshotStore, allowed_origins: set[str]):
    class Handler(BaseHTTPRequestHandler):
        server_version = "JXNU-KKAP/1.0"

        def log_message(self, fmt: str, *args: object) -> None:
            print(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}")

        def cors_origin(self) -> str | None:
            origin = self.headers.get("Origin")
            return origin if origin and origin in allowed_origins else None

        def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
            raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
            etag = '"' + hashlib.sha256(raw).hexdigest()[:24] + '"'
            if self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", "no-cache, max-age=0")
                origin = self.cors_origin()
                if origin:
                    self.send_header("Access-Control-Allow-Origin", origin)
                    self.send_header("Vary", "Origin, Accept-Encoding")
                self.end_headers()
                return

            accepts_gzip = "gzip" in (self.headers.get("Accept-Encoding") or "")
            body = gzip.compress(raw, compresslevel=5) if accepts_gzip else raw
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache, max-age=0")
            self.send_header("ETag", etag)
            self.send_header("X-Content-Type-Options", "nosniff")
            if accepts_gzip:
                self.send_header("Content-Encoding", "gzip")
            origin = self.cors_origin()
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin, Accept-Encoding")
            else:
                self.send_header("Vary", "Accept-Encoding")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            self.send_response(204)
            origin = self.cors_origin()
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Vary", "Origin")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            path = urlparse(self.path).path.rstrip("/") or "/"
            if path == "/healthz":
                payload = store.public_state(include_items=False)
                self.send_json(payload, 200 if payload["ok"] else 503)
                return
            if path == "/api/enrollments":
                payload = store.public_state(include_items=True)
                self.send_json(payload, 200 if payload["ok"] else 503)
                return
            if path == "/":
                self.send_json({"service": "jxnu-kkap", "endpoints": ["/healthz", "/api/enrollments"]})
                return
            self.send_json({"error": "not found"}, 404)

    return Handler


def main() -> None:
    bind = os.environ.get("KKAP_BIND", "127.0.0.1")
    port = int(os.environ.get("KKAP_PORT", "8787"))
    semester = os.environ.get("KKAP_SEMESTER", "2026-09")
    interval = max(10, int(os.environ.get("KKAP_REFRESH_SECONDS", "30")))
    allowed_origins = {
        origin.strip()
        for origin in os.environ.get(
            "KKAP_ALLOWED_ORIGINS",
            "https://test.better-jxnu-elective-system.pages.dev,http://localhost:5173,http://127.0.0.1:5173",
        ).split(",")
        if origin.strip()
    }

    store = SnapshotStore(semester, interval)
    worker = threading.Thread(target=store.run, name="kkap-refresh", daemon=True)
    worker.start()
    server = ThreadingHTTPServer((bind, port), make_handler(store, allowed_origins))

    def stop(_signum: int, _frame: object) -> None:
        store.stop_event.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"KKAP service listening on {bind}:{port}; semester={semester}; interval={interval}s")
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        store.stop_event.set()
        worker.join(timeout=5)
        server.server_close()


if __name__ == "__main__":
    main()
