#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
xk.jxnu.edu.cn 正选实时容量爬虫
  CAS 登录 xk 选课系统 -> 遍历某学期所有课程号(kch)
  -> GET /Step{N}/ChangeClass.aspx?kch={kch}&action=change  (该课所有教学班 容量/余量)
     Step 段与选课阶段对应（预选=Step1，正选/补退选=Step3 等），随 Default_config.aspx
     的「配置名称」变化——开抓前先用 --probe 核对，阶段变了要用 --step 传新前缀
     （或设 XK_STEP 环境变量）。
  -> 解析每个教学班的 {bjh, 班级名称, 教师, 授课人数, 剩余容量}
  -> 输出 UTF-8 JSON: data/semesters/<sem>/raw/xk_capacity.json

只读 GET，不发任何 POST 选课。

用法:
  python tools/crawl_capacity.py -u 202225303068 -p 'xxx' --sem 2026-09
  探针(只测登录+阶段+前N门):  ... --probe 3
  免手填账号密码(定时任务用): 设环境变量 XK_USERNAME / XK_PASSWORD 后不传 -u/-p
"""
import argparse
import base64
import html as htmllib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, __file__.replace("\\", "/").rsplit("/", 1)[0])
import cas_login as C

XK = "https://xk.jxnu.edu.cn"
CAS = "https://uis.jxnu.edu.cn/cas"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
REPO = __file__.replace("\\", "/").rsplit("/", 2)[0]


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def decode(body: bytes) -> str:
    try:
        return body.decode("utf-8")
    except UnicodeDecodeError:
        return body.decode("gbk", "ignore")


def raw_get(op, url, referer=None) -> bytes:
    headers = {"User-Agent": UA, "Accept": "text/html,*/*", "Accept-Language": "zh-CN"}
    if referer:
        headers["Referer"] = referer
    return op.open(urllib.request.Request(url, headers=headers), timeout=25).read()


# --------------------------------------------------------------------------- #
# Login (xk service)
# --------------------------------------------------------------------------- #
def login(username, password):
    op, cj = C.create_session()
    target_b64 = base64.b64encode(f"{XK}/Portal/default.aspx".encode()).decode()
    service = f"{XK}/sso/Memberlogin.aspx?targetUrl={{base64}}{target_b64}"
    lu = f"{CAS}/login?service=" + urllib.parse.quote(service, safe="")

    page = C.http_get(op, lu).read().decode("utf-8", "ignore")
    m = re.search(r'name="execution"\s+value="([^"]+)"', page)
    ex = m.group(1) if m else "e1s1"
    pw = C.rsa_encrypt_password(password, C.get_public_key())
    data = urllib.parse.urlencode({
        "username": username, "password": pw, "execution": ex,
        "_eventId": "submit", "geolocation": "", "currentMenu": "1",
        "failN": "-1", "mfaState": "", "rememberMe": "false",
        "trustAgent": "", "fpVisitorId": "",
    })
    C.http_post(op, lu, data, referer=lu).read()
    # 预热: 落地 xk 门户, 拿 ASP.NET_SessionId
    C.http_get(op, f"{XK}/Portal/default.aspx").read()
    ok = any(c.name == "ASP.NET_SessionId" for c in cj)
    return op, ok


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #
def clean(s: str) -> str:
    s = re.sub(r"<[^>]+>", "", s)
    s = htmllib.unescape(s).replace("\xa0", " ")
    return re.sub(r"\s+", " ", s).strip()


def get_config(op):
    """读取系统阶段/时间配置, 判断当前是否处于正选/可见容量阶段。"""
    try:
        h = decode(raw_get(op, f"{XK}/Default_config.aspx"))
    except Exception as e:
        return {"error": str(e)}
    text = clean(h)
    return {"len": len(h), "excerpt": text[:600]}


def _to_int(s):
    s = (s or "").strip()
    return int(s) if re.fullmatch(r"-?\d+", s) else None


def parse_change_class(html_, kch):
    """ChangeClass.aspx -> {kch, blocked, classes:[...]}。

    列序(实测 2026 正选): 序号|班级名称|教师|专业班?|授课人数|剩余容量|[班级容量已满]|操作。
    授课人数=已选, 剩余容量=余量(可能为 0 或负=已满)。
    blocked=True 表示该课对本账号不可见(非本人落选课, 返回「对不起…只能增选落选的课程」)。
    """
    blocked = "对不起" in html_ and "落选" in html_
    classes = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html_, re.S | re.I):
        bjh_m = re.search(r"bjh=([^\"'&]+)", tr)
        if not bjh_m:
            continue
        cells = [clean(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S | re.I)]
        nonempty = [c for c in cells if c]
        if not nonempty or not nonempty[0].isdigit():
            continue
        full = nonempty[-1] == "班级容量已满"  # 满则末列多一个提示
        classes.append({
            "bjh": htmllib.unescape(bjh_m.group(1)),
            "className": nonempty[1] if len(nonempty) > 1 else "",
            "teacher": nonempty[2] if len(nonempty) > 2 else "",
            "enrolled": _to_int(nonempty[4]) if len(nonempty) > 4 else None,
            "remaining": _to_int(nonempty[5]) if len(nonempty) > 5 else None,
            "full": full,
        })
    return {"kch": kch, "blocked": blocked, "classes": classes}


# --------------------------------------------------------------------------- #
# Crawl
# --------------------------------------------------------------------------- #
def load_kch_list(sem):
    """从该学期 formal_schedule.json 取唯一课程号列表 + 名称。"""
    path = f"{REPO}/data/semesters/{sem}/raw/formal_schedule.json"
    rows = json.load(open(path, encoding="utf-8-sig"))
    out = {}
    for r in rows:
        kch = (r.get("课程号") or "").strip()
        if kch and kch not in out:
            out[kch] = r.get("课程名称") or ""
    return out


def crawl(username, password, sem, out_path, probe=None, delay=0.25, step="Step3"):
    if not username or not password:
        log("[x] 缺少账号/密码：传 -u/-p 或设 XK_USERNAME / XK_PASSWORD 环境变量")
        sys.exit(1)
    op, ok = login(username, password)
    log(f"[i] 登录 ASP.NET_SessionId 下发: {ok}")
    cfg = get_config(op)
    log(f"[i] Default_config: {json.dumps(cfg, ensure_ascii=False)[:400]}")

    kch_map = load_kch_list(sem)
    kchs = list(kch_map.keys())
    if probe:
        kchs = kchs[:probe]
    log(f"[i] 待查课程号 {len(kchs)} 门 (probe={probe}, step={step})")

    result = {"semester": sem, "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S"),
              "config": cfg, "courses": []}
    n_blocked = n_ok = 0
    for i, kch in enumerate(kchs, 1):
        url = f"{XK}/{step}/ChangeClass.aspx?kch={kch}&action=change"
        try:
            h = decode(raw_get(op, url, referer=f"{XK}/{step}/"))
        except Exception as e:
            log(f"    [x] {kch} 取页失败: {e}")
            continue
        rec = parse_change_class(h, kch)
        rec["name"] = kch_map[kch]
        result["courses"].append(rec)
        if rec["blocked"]:
            n_blocked += 1
        elif rec["classes"]:
            n_ok += 1
        if probe or i % 25 == 0:
            tag = "BLOCKED" if rec["blocked"] else f"{len(rec['classes'])}班"
            log(f"    [{i}/{len(kchs)}] {kch} {kch_map[kch][:14]}: {tag}  (累计 可见{n_ok}/拦{n_blocked})")
            if probe and rec["classes"]:
                log("      sample: " + json.dumps(rec["classes"][:2], ensure_ascii=False))
        time.sleep(delay)
        if not probe and i % 50 == 0:
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=1)

    result["summary"] = {"total": len(result["courses"]), "visible": n_ok,
                         "blocked": n_blocked}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    log(f"[完成] 共{len(result['courses'])}门: 可见{n_ok} / 拦截{n_blocked} -> {out_path}")
    return result


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="xk 正选实时容量爬虫")
    ap.add_argument("--username", "-u", default=os.environ.get("XK_USERNAME"))
    ap.add_argument("--password", "-p", default=os.environ.get("XK_PASSWORD"))
    ap.add_argument("--sem", default="2026-09")
    ap.add_argument("--out", "-o", default=None)
    ap.add_argument("--probe", type=int, default=None,
                    help="只测前 N 门(并打印 cell 结构), 用于探阶段/列序")
    ap.add_argument("--delay", type=float, default=0.25)
    ap.add_argument("--step", default=os.environ.get("XK_STEP", "Step3"),
                    help="ChangeClass.aspx 的 Step 前缀，随选课阶段变化，见文件头注释")
    args = ap.parse_args()
    out = args.out or f"{REPO}/data/semesters/{args.sem}/raw/xk_capacity.json"
    crawl(args.username, args.password, args.sem, out, args.probe, args.delay, args.step)
