#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Public_Kkap.aspx → base formal_schedule.json（无登录、无 enrichment）。

方案A 的取数端：Public_Kkap 是公开页（无需 CAS），一次 GET+POST 拿到全校开课安排表。
课程号(kch)/班级号(bjh) 从每行链接的 href 解析（页面文本列里没有）。

为什么不做油猴那套 enrichment（CourseID / 课程信息 / 教师 UserNum，4-5k 次请求）：
  - 学分/简介 build_data.py 取自 master/*.json；
  - 教号 build_data.py 有「按 (课程号,姓名) 查预选目录」兜底，绝大多数能补上。
故 base 行足够喂 build_data；产物与油猴版基本一致。

输出字段对齐 formal_schedule.json（build_data 只用 课程号/班级号/任课教师/星期/节次/教室/课程名称/班级名称/单位名称）。
"""
import argparse
import html as htmllib
import http.cookiejar
import json
import re
import ssl
import sys
import urllib.parse
import urllib.request

KKAP_URL = "https://jwc.jxnu.edu.cn/MyControl/Public_Kkap.aspx"
UA = "Mozilla/5.0 (compatible; JXNU-Schedule-Export/1.0)"


def norm(v: str) -> str:
    return re.sub(r"\s+", " ", htmllib.unescape(re.sub(r"<[^>]+>", "", v or "")).replace("\xa0", " ")).strip()


def fetch_result_html() -> str:
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        urllib.request.HTTPCookieProcessor(cj),
    )
    page = op.open(urllib.request.Request(KKAP_URL, headers={"User-Agent": UA}), timeout=25).read().decode("utf-8", "ignore")
    vs = re.search(r'__VIEWSTATE"\s+value="([^"]+)"', page)
    if not vs:
        raise RuntimeError("Public_Kkap 未返回 __VIEWSTATE（页面结构变了？）")
    ev = re.search(r'__EVENTVALIDATION"\s+value="([^"]+)"', page)
    vg = re.search(r'__VIEWSTATEGENERATOR"\s+value="([^"]+)"', page)
    form = {
        "__VIEWSTATE": vs.group(1),
        "__VIEWSTATEGENERATOR": vg.group(1) if vg else "",
        "__EVENTVALIDATION": ev.group(1) if ev else "",
        "btnSearch": "查询",
    }
    req = urllib.request.Request(
        KKAP_URL,
        data=urllib.parse.urlencode(form).encode(),
        headers={"User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded",
                 "Referer": KKAP_URL, "Origin": "https://jwc.jxnu.edu.cn"},
    )
    return op.open(req, timeout=60).read().decode("utf-8", "ignore")


def parse_rows(result_html: str) -> list[dict]:
    """表格行 → formal_schedule 行（不过滤空格子，按位序取，href 取 kch/bjh/xq）。"""
    rows = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", result_html, re.S | re.I):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S | re.I)
        if len(cells) < 9:
            continue
        t = [norm(c) for c in cells]
        if not t[0].isdigit():
            continue
        m_kch = re.search(r"kch=([^&\"'>]+)", tr)
        m_bjh = re.search(r"bjh=([^&\"'>]+)", tr)
        m_xq = re.search(r"xq=([^&\"'>]+)", tr)
        kch = m_kch.group(1) if m_kch else ""
        bjh = m_bjh.group(1) if m_bjh else ""
        if not kch or not bjh:
            continue
        rows.append({
            "序号": t[0],
            "单位名称": t[1] if len(t) > 1 else "",
            "课程名称": t[2] if len(t) > 2 else "",
            "班级名称": t[3] if len(t) > 3 else "",
            "任课教师": t[4] if len(t) > 4 else "",
            "教室": t[5] if len(t) > 5 else "",
            "星期": t[6] if len(t) > 6 else "",
            "节次": t[7] if len(t) > 7 else "",
            "授课人数": t[8] if len(t) > 8 else "",
            "课程号": kch,
            "班级号": bjh,
            "学期": urllib.parse.unquote(m_xq.group(1)) if m_xq else "",
        })
    if not rows:
        raise RuntimeError("Public_Kkap 解析到 0 行（页面结构变了 / 未查询？）")
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(description="Public_Kkap → base formal_schedule.json")
    ap.add_argument("--out", "-o", required=True)
    args = ap.parse_args()
    rows = parse_rows(fetch_result_html())
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
    print(f"exported {len(rows)} rows -> {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
