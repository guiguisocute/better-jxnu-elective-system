#!/usr/bin/env python3
"""Fetch JXNU teaching-class enrollment counts from the public KKAP page.

Public_Kkap.aspx does not require CAS authentication.  This module deliberately
contains no credentials and performs only the GET/POST pair needed by the page's
search form.  It is shared by the CLI exporter and the long-running VPS service.
"""

from __future__ import annotations

import argparse
import html
import http.cookiejar
import json
import re
import ssl
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

KKAP_URL = "https://jwc.jxnu.edu.cn/MyControl/Public_Kkap.aspx"
USER_AGENT = "Mozilla/5.0 (compatible; JXNU-Elective-Monitor/1.0)"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def normalize_text(value: str) -> str:
    value = html.unescape(re.sub(r"<[^>]+>", "", value or ""))
    return re.sub(r"\s+", " ", value.replace("\xa0", " ")).strip()


def create_session() -> urllib.request.OpenerDirector:
    cookie_jar = http.cookiejar.CookieJar()
    context = ssl.create_default_context()
    return urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=context),
        urllib.request.HTTPCookieProcessor(cookie_jar),
    )


def fetch_enrollments(opener: urllib.request.OpenerDirector | None = None) -> list[dict[str, Any]]:
    """Return raw schedule rows from the public page.

    A teaching class with several weekly slots appears more than once.  Call
    ``deduplicate_enrollments`` before publishing the result.
    """

    opener = opener or create_session()
    request = urllib.request.Request(KKAP_URL, headers={"User-Agent": USER_AGENT})
    with opener.open(request, timeout=15) as response:
        page = response.read().decode("utf-8", errors="ignore")

    viewstate_match = re.search(r'__VIEWSTATE"\s+value="([^"]+)"', page)
    if not viewstate_match:
        raise RuntimeError("Public_Kkap page did not contain __VIEWSTATE")
    event_match = re.search(r'__EVENTVALIDATION"\s+value="([^"]+)"', page)
    generator_match = re.search(r'__VIEWSTATEGENERATOR"\s+value="([^"]+)"', page)
    form = {
        "__VIEWSTATE": viewstate_match.group(1),
        "__VIEWSTATEGENERATOR": generator_match.group(1) if generator_match else "",
        "__EVENTVALIDATION": event_match.group(1) if event_match else "",
        "btnSearch": "查询",
    }
    request = urllib.request.Request(
        KKAP_URL,
        data=urllib.parse.urlencode(form).encode(),
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": KKAP_URL,
            "Origin": "https://jwc.jxnu.edu.cn",
        },
    )
    with opener.open(request, timeout=40) as response:
        result_page = response.read().decode("utf-8", errors="ignore")

    results: list[dict[str, Any]] = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", result_page, re.DOTALL | re.IGNORECASE):
        cells = [
            normalize_text(cell)
            for cell in re.findall(r"<td[^>]*>(.*?)</td>", row, re.DOTALL | re.IGNORECASE)
        ]
        cells = [cell for cell in cells if cell]
        if len(cells) < 9 or not cells[0].isdigit():
            continue
        enrolled = int(cells[8]) if re.fullmatch(r"\d+", cells[8]) else None
        if enrolled is None:
            continue
        results.append(
            {
                "course": cells[2],
                "class_name": cells[3],
                "teacher": cells[4],
                "enrolled": enrolled,
                "room": cells[5],
                "weekday": cells[6],
                "period": cells[7],
            }
        )
    if not results:
        raise RuntimeError("Public_Kkap returned no enrollment rows")
    return results


def deduplicate_enrollments(rows: list[dict[str, Any]]) -> tuple[list[list[Any]], int]:
    """Collapse repeated weekly slots to compact ``[course,class,teacher,count]`` rows."""

    grouped: dict[tuple[str, str, str], set[int]] = {}
    for row in rows:
        key = (
            normalize_text(str(row.get("course", ""))),
            normalize_text(str(row.get("class_name", ""))),
            normalize_text(str(row.get("teacher", ""))),
        )
        if not key[0] or not key[1]:
            continue
        grouped.setdefault(key, set()).add(int(row["enrolled"]))

    conflicts = sum(1 for counts in grouped.values() if len(counts) > 1)
    # A conflict would mean the supposedly identical teaching class has different
    # values in one source response.  Publish the largest value and expose the
    # conflict count so health monitoring can flag the upstream inconsistency.
    items = [[*key, max(counts)] for key, counts in sorted(grouped.items())]
    return items, conflicts


def build_snapshot(semester: str) -> dict[str, Any]:
    rows = fetch_enrollments()
    items, conflicts = deduplicate_enrollments(rows)
    return {
        "version": 1,
        "semester": semester,
        "fetchedAt": utc_now(),
        "sourceRows": len(rows),
        "classCount": len(items),
        "conflictCount": conflicts,
        "items": items,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Export public JXNU enrollment counts")
    parser.add_argument("--semester", default="2026-09")
    parser.add_argument("--json", "-j", required=True, help="output JSON path")
    args = parser.parse_args()
    snapshot = build_snapshot(args.semester)
    with open(args.json, "w", encoding="utf-8") as output:
        json.dump(snapshot, output, ensure_ascii=False, separators=(",", ":"))
    print(f"exported {snapshot['classCount']} classes to {args.json}")


if __name__ == "__main__":
    main()
