#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
江西师范大学 选课开班(课程动态) 全学院课程爬虫
  CAS 登录 -> 拿 ASP.NET_SessionId + SjdJsfJfXfsFsdf
  -> 打开左侧学院树(IE WebControls TreeView, 懒加载, 逐节点 postback 展开)
  -> 选修课叶子 -> Course_YXKB_View_1.aspx?CourseNum=xxx   (选课开班状态)
     必修课叶子 -> Course_YXKB_09_View_1.aspx?CourseNum=xxx(选课开班处理(必修课) + 选课结果)
  -> 解析每页全部表单信息 -> 输出 UTF-8 JSON

用法:
  python tools/crawl_courses.py -u 202426201063 -p 'xxx' -o tools/courses.json
  调试少量:  ... --limit-colleges 2

关键坑(给后续维护者):
  1) cookie 必须跨请求保持; CAS 第3步返回的 ASP.NET_SessionId 要带到后续每个请求
  2) service URL 必须是  targetUrl={base64}<base64>  —— 字面量 {base64} 前缀不能省,
     否则不会下发 College 模块所需的 SjdJsfJfXfsFsdf cookie
  3) TvList 偶发后端粘性问题返回 "请重新访问" alert; 整会话级重试无效, 需重新登录
  4) 页面 charset 不统一(College 多为 gb2312, 门户为 utf-8), 按 meta 自动判定; 输出统一 UTF-8
"""
import argparse
import html as htmllib
import json
import re
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, __file__.replace("\\", "/").rsplit("/", 1)[0])
import cas_login as C

CAS = "https://uis.jxnu.edu.cn/cas"
SERVICE = ("https://jwc.jxnu.edu.cn/sso/login.aspx?targetUrl="
           "{base64}aHR0cHM6Ly9qd2MuanhudS5lZHUuY24vUG9ydGFsL0luZGV4LmFzcHg=")
PORTAL = "https://jwc.jxnu.edu.cn/Portal/Index.aspx"
FRAMESET = "https://jwc.jxnu.edu.cn/College/Course_YXKB_view.htm"
TV = "https://jwc.jxnu.edu.cn/College/Course_YXKB_View_TvList.aspx"
DETAIL_XX = "https://jwc.jxnu.edu.cn/College/Course_YXKB_View_1.aspx?CourseNum={}"
DETAIL_BX = "https://jwc.jxnu.edu.cn/College/Course_YXKB_09_View_1.aspx?CourseNum={}"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- #
# HTTP helpers
# --------------------------------------------------------------------------- #
def decode(body: bytes) -> str:
    # 注意: College 页面的 <meta charset> 谎报 gb2312, 实际是 UTF-8。
    # 因此一律优先按 UTF-8 严格解码, 仅当真为 GBK 字节(抛异常)时回退。
    try:
        return body.decode("utf-8")
    except UnicodeDecodeError:
        return body.decode("gbk", "ignore")


def raw_get(op, url, referer=None) -> bytes:
    headers = {"User-Agent": UA, "Accept": "text/html,*/*", "Accept-Language": "zh-CN"}
    if referer:
        headers["Referer"] = referer
    return op.open(urllib.request.Request(url, headers=headers), timeout=25).read()


def raw_post(op, url, fields, referer=None) -> bytes:
    body = urllib.parse.urlencode(fields).encode()
    headers = {"User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded"}
    if referer:
        headers["Referer"] = referer
    return op.open(urllib.request.Request(url, data=body, headers=headers), timeout=25).read()


# --------------------------------------------------------------------------- #
# Login
# --------------------------------------------------------------------------- #
def login(username, password):
    op, cj = C.create_session()
    lu = f"{CAS}/login?service=" + urllib.parse.quote(SERVICE, safe="")
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
    C.http_get(op, PORTAL).read()       # 预热: 触发 SjdJsfJfXfsFsdf 下发
    C.http_get(op, FRAMESET).read()
    ok = any(c.name == "SjdJsfJfXfsFsdf" for c in cj)
    return op, ok


class Session:
    """持有 opener + 当前树 HTML(含 __VIEWSTATE); 失效时自动重新登录。"""

    def __init__(self, username, password):
        self.username, self.password = username, password
        self.op = None
        self.tree = None
        self.relogin()

    def relogin(self, max_try=10):
        for i in range(max_try):
            op, ok = login(self.username, self.password)
            if not ok:
                log(f"[!] 登录未下发 College cookie, 重试({i+1})")
                time.sleep(0.6)
                continue
            for _ in range(4):
                h = decode(raw_get(op, TV))
                if len(h) > 5000 and "alert(" not in h:
                    self.op, self.tree = op, h
                    log(f"[+] 登录成功, 课程树 {len(h)} 字节 (第{i+1}次登录)")
                    return
                time.sleep(0.3)
            log(f"[!] 会话被拒(后端粘性), 重新登录({i+1})")
            time.sleep(0.6)
        raise RuntimeError("多次登录仍无法加载课程树")

    def viewstate(self):
        vs = re.search(r'__VIEWSTATE" value="([^"]*)"', self.tree).group(1)
        vg = re.search(r'__VIEWSTATEGENERATOR" value="([^"]*)"', self.tree).group(1)
        return vs, vg

    def expand(self, target, idx, tries=6):
        """从基准树(V0)独立展开一个学院节点, 返回该学院页面 HTML。"""
        for _ in range(tries):
            vs, vg = self.viewstate()
            h = decode(raw_post(self.op, TV, {
                "__EVENTTARGET": target, "__EVENTARGUMENT": f"onexpand,{idx}",
                "__VIEWSTATE": vs, "__VIEWSTATEGENERATOR": vg,
            }, referer=TV))
            if len(h) > 3000 and "alert(" not in h:
                return h
            time.sleep(0.3)
        log(f"[!] 展开 {target},{idx} 反复失败 -> 重新登录")
        self.relogin()
        return self.expand(target, idx, tries)

    def detail(self, url, tries=6):
        for _ in range(tries):
            h = decode(raw_get(self.op, url, referer=FRAMESET))
            if "alert(" not in h and "lblTitle" in h:
                return h
            time.sleep(0.3)
        log(f"[!] 详情反复失败 -> 重新登录: {url}")
        self.relogin()
        for _ in range(tries):
            h = decode(raw_get(self.op, url, referer=FRAMESET))
            if "alert(" not in h and "lblTitle" in h:
                return h
            time.sleep(0.3)
        return ""  # 放弃该课程


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #
def clean(s: str) -> str:
    s = re.sub(r"<[^>]+>", "", s)
    s = htmllib.unescape(s).replace("\xa0", " ")
    return re.sub(r"\s+", " ", s).strip()


def parse_colleges(tree_html: str):
    """返回 {'tv':[(idx,name)...], 'tvNew':[(idx,name)...]} (选修/必修 两棵树)。"""
    h = tree_html.replace("&#39;", "'")
    i_new = h.find('id="tvNew"')
    seg_tv, seg_new = h[:i_new], h[i_new:]

    def nodes(seg):
        out = []
        for m in re.finditer(r"onexpand,(\d+)'.{0,600}?<Strong>(.*?)</Strong>", seg, re.S):
            name = re.sub(r"[（(](?:选修课|必修课)[)）]\s*$", "", clean(m.group(2)))
            out.append((int(m.group(1)), name))
        # 去重保持顺序 (每节点可能出现多次)
        seen, uniq = set(), []
        for idx, name in out:
            if idx not in seen:
                seen.add(idx)
                uniq.append((idx, name))
        return uniq

    return {"tv": nodes(seg_tv), "tvNew": nodes(seg_new)}


def parse_infor(span_inner: str):
    """lblInfor -> (dict 字段, [状态说明...], 原文)。"""
    t = re.sub(r"<li>", "\n", span_inner)
    t = re.sub(r"<br\s*/?>", "\n", t, flags=re.I)
    t = re.sub(r"</?u>", "", t)
    t = clean_keep_lines(t)
    lines = [l.strip() for l in t.split("\n") if l.strip()]
    fields, notes = {}, []
    if lines:
        for part in re.split(r"[　　]", lines[0]):
            if "：" in part:
                k, v = part.split("：", 1)
                fields[k.strip()] = v.strip()
            elif part.strip():
                notes.append(part.strip())
        notes += lines[1:]
    full = " ".join(lines)
    return fields, notes, full


def clean_keep_lines(s: str) -> str:
    s = re.sub(r"<[^>]+>", "", s)
    s = htmllib.unescape(s).replace("\xa0", " ")
    s = re.sub(r"[ \t]+", " ", s)
    return s


def parse_table(table_html: str):
    """表格 -> list[list[str]] (按行, 每行单元格文本; 含表头行)。"""
    rows = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", table_html, re.S | re.I):
        cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S | re.I)
        rows.append([clean(c) for c in cells])
    return rows


def rows_to_dicts(rows):
    if not rows:
        return []
    header = rows[0]
    out = []
    for r in rows[1:]:
        if not any(c for c in r):
            continue
        out.append({header[i] if i < len(header) else f"col{i}": r[i]
                    for i in range(len(r))})
    return out


def get_span(html_, span_id):
    m = re.search(rf'<span id="{span_id}"[^>]*>(.*?)</span>', html_, re.S)
    return m.group(1) if m else ""


def get_table(html_, table_id):
    m = re.search(rf'<table[^>]*id="{table_id}"[^>]*>(.*?)</table>', html_, re.S | re.I)
    return m.group(1) if m else ""


def parse_detail(html_, nature, course_num):
    title = clean(get_span(html_, "lblTitle"))
    fields, notes, info_raw = parse_infor(get_span(html_, "lblInfor"))
    rec = {
        "course_num": course_num,
        "nature": nature,                 # 选修 / 必修
        "title": title,
        "info": fields,
        "info_notes": notes,              # 如 "教学院长未审核！"
        "info_raw": info_raw,
    }
    if nature == "选修":
        rows = parse_table(get_table(html_, "dgContent"))
        rec["开班"] = rows_to_dicts(rows)
    else:  # 必修
        rec["班级"] = rows_to_dicts(parse_table(get_table(html_, "dgContent")))
        rec["选课结果"] = rows_to_dicts(parse_table(get_table(html_, "gvResult")))
    return rec


# --------------------------------------------------------------------------- #
# Crawl
# --------------------------------------------------------------------------- #
def collect_course_nums(expanded_html, pattern):
    h = expanded_html.replace("&#39;", "'")
    seen, out = set(), []
    for cn in re.findall(pattern, h):
        cn = cn.strip()
        if cn not in seen:
            seen.add(cn)
            out.append(cn)
    return out


def crawl(username, password, out_path, limit_colleges=None):
    s = Session(username, password)
    colleges = parse_colleges(s.tree)
    log(f"[i] 选修学院 {len(colleges['tv'])} 个, 必修学院 {len(colleges['tvNew'])} 个")

    plan = []  # (nature, target, idx, college_name)
    for idx, name in colleges["tv"]:
        plan.append(("选修", "tv", idx, name))
    for idx, name in colleges["tvNew"]:
        plan.append(("必修", "tvNew", idx, name))
    if limit_colleges:
        plan = plan[:limit_colleges]

    result = {"semester": None, "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S"),
              "colleges": []}
    total_courses = 0

    for nature, target, idx, college in plan:
        html_exp = s.expand(target, idx)
        if nature == "选修":
            nums = collect_course_nums(html_exp,
                                       r"Course_YXKB_View_1\.aspx\?CourseNum=(\w+)")
            url_tpl = DETAIL_XX
        else:
            nums = collect_course_nums(html_exp,
                                       r"Course_YXKB_09_View_1\.aspx\?CourseNum=(\w+)")
            url_tpl = DETAIL_BX
        log(f"[>] [{nature}] {college}: {len(nums)} 门课")
        courses = []
        for j, cn in enumerate(nums, 1):
            d = s.detail(url_tpl.format(cn))
            if not d:
                log(f"    [x] 跳过 {cn} (取详情失败)")
                continue
            rec = parse_detail(d, nature, cn)
            if result["semester"] is None and rec["info"].get("开课学期"):
                result["semester"] = rec["info"]["开课学期"]
            courses.append(rec)
            total_courses += 1
            if j % 25 == 0:
                log(f"    ... {j}/{len(nums)}")
        result["colleges"].append({"college": college, "nature": nature,
                                   "course_count": len(courses), "courses": courses})
        # 增量落盘, 防中途崩溃丢全部
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        log(f"    [✓] {college}({nature}) 完成, 累计 {total_courses} 门, 已写入 {out_path}")

    result["total_courses"] = total_courses
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    log(f"[完成] 共 {total_courses} 门课, 输出 -> {out_path}")
    return result


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="江西师范大学全学院选课开班信息爬虫")
    ap.add_argument("--username", "-u", required=True)
    ap.add_argument("--password", "-p", required=True)
    ap.add_argument("--out", "-o", default="tools/courses.json")
    ap.add_argument("--limit-colleges", type=int, default=None,
                    help="只爬前 N 个(学院,性质)组合, 用于调试")
    args = ap.parse_args()
    crawl(args.username, args.password, args.out, args.limit_colleges)
