#!/usr/bin/env python3
"""
教务 Xfz_Kcb 课表实时抓取 —— 单次登录翻全部学期，产出 build_record 所需的聚合输入。

依赖：requests + 标准库（VPS 无 lxml/bs4）；复用 tools/cas_login.py 的 RSA 加密。
凭据走 env（XK_USERNAME / XK_PASSWORD），本文件不含任何账号密码。

关键点（实测 2026-07-04，详见 reference_jwc_live_schedule 记忆）：
  - 登录必须走 targetUrl 流程：GET /sso/login.aspx 跟重定向拿带 targetUrl 的 service，
    对该 service 做 CAS 登录，ticket 才经 Portal/LoginAccount.aspx?t=sso 消费、设 cookie SjdJsfJfXfsFsdf。
  - 翻学期：POST 回传 _ctl6:ddlSterm=<value> + _ctl6:btnSearch=确定 + __VIEWSTATE 三件套。
  - 该账号有全校级访问权（任意 UserNum）。页面含姓名 → 本模块只取 className/学号，姓名一律丢弃（脱敏）。

网格/明细解析逐条移植自 tools/getStudent.js（analyzeTable / parseCourseChunks / mergeScheduleItems …）。
"""

from __future__ import annotations

import base64
import os
import re
import sys
import time
import urllib.parse
from html.parser import HTMLParser
from html import unescape

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cas_login as C  # noqa: E402

CAS = "https://uis.jxnu.edu.cn/cas"
JWC = "https://jwc.jxnu.edu.cn"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
DAY_LABELS = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]
AUTH_COOKIE = "SjdJsfJfXfsFsdf"  # 教务应用会话 cookie（存在=已登录）


# ============ 文本工具（移植 getStudent.js） ============

def clean_text(value) -> str:
    s = str(value or "")
    s = s.replace(" ", " ")
    s = re.sub(r"[\t\r]+", " ", s)
    s = re.sub(r"\n{2,}", "\n", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def normalize_key_part(value) -> str:
    return re.sub(r"\s+", "", clean_text(value))


def detail_lookup_key(course_name, teaching_class) -> str:
    return f"{normalize_key_part(course_name)}||{normalize_key_part(teaching_class)}"


def is_location_line(line) -> bool:
    return bool(re.match(r"^[（(]\s*.+?\s*[)）]$", clean_text(line)))


def extract_location(line) -> str:
    return re.sub(r"\s*[)）]$", "", re.sub(r"^[（(]\s*", "", clean_text(line)))


def is_teaching_class_descriptor(line) -> bool:
    n = clean_text(line)
    return ("班" in n) or n.startswith("教工") or n.startswith("合班")


def is_likely_placeholder_course_name(line) -> bool:
    n = clean_text(line)
    return bool(re.match(r"^(?:\d{2}级.*班|教工.*班|合班.*班)$", n)) or bool(re.search(r"#\d+班\.?$", n))


def split_teaching_class_and_next(line):
    n = clean_text(line)
    if "、" not in n:
        return None
    parts = re.split(r"\s*、\s*", n, maxsplit=1)
    left = clean_text(parts[0])
    right = clean_text(parts[1]) if len(parts) > 1 else ""
    if not left or not right:
        return None
    if not is_teaching_class_descriptor(left) or is_location_line(right):
        return None
    return {"teachingClass": left, "nextCourseName": right}


# ============ 最小 HTML 表格解析（stdlib，无 lxml） ============

def slice_table_html(page: str, anchor_id: str):
    """从页面里切出某个表格的 HTML。

    两种形态都兼容：<table id="anchor">…（明细表）/ <div id="anchor"><table>…（周课表外壳）。
    用 <table>/</table> 深度配对定位闭合，返回该表 HTML；找不到返回 None。
    """
    m = re.search(r'<table\b[^>]*\bid="%s"' % re.escape(anchor_id), page, re.I)
    if m:
        start = m.start()
    else:
        i = page.find('id="%s"' % anchor_id)
        if i < 0:
            return None
        # 周课表壳 <div id="_ctl6_NewKcb"> 里是大写 <TABLE>（旧 ASP.NET），大小写不敏感找下一张表。
        tm = re.search(r"<table\b", page[i:], re.I)
        if not tm:
            return None
        start = i + tm.start()
    depth = 0
    for mm in re.finditer(r"<(/?)table\b", page[start:], re.I):
        if mm.group(1) == "":
            depth += 1
        else:
            depth -= 1
            if depth == 0:
                gt = page.find(">", start + mm.start())
                return page[start:gt + 1]
    return None


class _TableParser(HTMLParser):
    """把一个表格 HTML 解析成 rows[list of cells]。

    每个 cell = {rowspan, colspan, lines, text}。lines 复刻 getStudent.js extractCellLines：
    <br>/</div>/</p> 视为换行，逐行 clean_text 后去空行。
    """

    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.rows = []
        self._row = None
        self._cell = None
        self._buf = []

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            a = dict(attrs)
            self._cell = {
                "rowspan": int(a.get("rowspan") or 1) if str(a.get("rowspan") or "1").isdigit() else 1,
                "colspan": int(a.get("colspan") or 1) if str(a.get("colspan") or "1").isdigit() else 1,
            }
            self._buf = []
        elif tag == "br" and self._cell is not None:
            self._buf.append("\n")

    def handle_startendtag(self, tag, attrs):
        if tag.lower() == "br" and self._cell is not None:
            self._buf.append("\n")

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in ("div", "p") and self._cell is not None:
            self._buf.append("\n")
        elif tag in ("td", "th") and self._cell is not None:
            raw = "".join(self._buf)
            lines = [clean_text(x) for x in raw.replace("\r", "").split("\n")]
            lines = [x for x in lines if x]
            self._cell["lines"] = lines
            self._cell["text"] = clean_text(raw.replace("\n", " "))
            self._row.append(self._cell)
            self._cell = None
            self._buf = []
        elif tag == "tr" and self._row is not None:
            self.rows.append(self._row)
            self._row = None

    def handle_data(self, data):
        if self._cell is not None:
            self._buf.append(data)

    def handle_entityref(self, name):
        if self._cell is not None:
            self._buf.append(unescape("&%s;" % name))

    def handle_charref(self, name):
        if self._cell is not None:
            self._buf.append(unescape("&#%s;" % name))


def parse_table_rows(table_html: str):
    p = _TableParser()
    p.feed(table_html)
    if p._row:  # 未闭合的最后一行兜底
        p.rows.append(p._row)
    return p.rows


# ============ 网格重建（移植 analyzeTable） ============

def analyze_table(rows):
    """rows(list of cells) → (grid, placements)，复刻 getStudent.js analyzeTable 的 rowspan/colspan 展开。"""
    grid = []
    placements = []
    for row_index, row in enumerate(rows):
        col_index = 0
        for cell in row:
            while row_index < len(grid) and col_index < len(grid[row_index]) and grid[row_index][col_index] is not None:
                col_index += 1
            rowspan = cell["rowspan"]
            colspan = cell["colspan"]
            placements.append({"cell": cell, "rowIndex": row_index, "colIndex": col_index,
                               "rowSpan": rowspan, "colSpan": colspan})
            for r_off in range(rowspan):
                tr = row_index + r_off
                while len(grid) <= tr:
                    grid.append([])
                g = grid[tr]
                need = col_index + colspan
                while len(g) < need:
                    g.append(None)
                for c_off in range(colspan):
                    g[col_index + c_off] = cell
            col_index += colspan
    return grid, placements


def parse_periods_from_row_label(label):
    n = re.sub(r"\s+", "", clean_text(label))
    return {"12": [1, 2], "3": [3], "4": [4], "5": [5], "67": [6, 7], "89": [8, 9], "晚上": [10, 11]}.get(n)


def parse_course_chunks(cell):
    """cell.lines → [{courseName, location, teachingClass}]，复刻 parseCourseChunks 的队列拆分。"""
    lines = list(cell.get("lines") or [])
    if not lines:
        return []
    chunks = []
    queue = lines[:]
    while queue:
        course_name = clean_text(queue.pop(0))
        if not course_name:
            continue
        location = ""
        if queue and is_location_line(queue[0]):
            location = extract_location(queue.pop(0))
        teaching_class = ""
        if queue and not is_location_line(queue[0]):
            descriptor = clean_text(queue.pop(0))
            split = split_teaching_class_and_next(descriptor)
            if split:
                teaching_class = split["teachingClass"]
                queue.insert(0, split["nextCourseName"])
            else:
                teaching_class = descriptor
        if not location and not teaching_class and is_likely_placeholder_course_name(course_name):
            continue
        chunks.append({"courseName": course_name, "location": location, "teachingClass": teaching_class})
    return chunks


def parse_detail_courses(detail_rows):
    """明细表 rows → [{courseNo, courseName, weeklyHours, teachingClass, teacher}]（跳过表头）。"""
    out = []
    for row in detail_rows[1:]:
        cells = [clean_text(" ".join(c.get("lines") or []) or c.get("text", "")) for c in row]
        if len(cells) < 5:
            continue
        out.append({
            "courseNo": cells[0], "courseName": cells[1], "weeklyHours": cells[2],
            "teachingClass": cells[3], "teacher": cells[4],
        })
    return out


def build_detail_lookup(detail_courses):
    exact, by_name = {}, {}
    for c in detail_courses:
        exact.setdefault(detail_lookup_key(c["courseName"], c["teachingClass"]), []).append(c)
        by_name.setdefault(normalize_key_part(c["courseName"]), []).append(c)
    return {"exact": exact, "byName": by_name}


def match_detail_course(item, lookup):
    ex = lookup["exact"].get(detail_lookup_key(item["courseName"], item["teachingClass"])) or []
    if ex:
        return ex[0]
    names = lookup["byName"].get(normalize_key_part(item["courseName"])) or []
    if len(names) == 1:
        return names[0]
    if len(names) > 1 and item["teachingClass"]:
        cur = normalize_key_part(item["teachingClass"])
        filtered = [c for c in names if cur in normalize_key_part(c["teachingClass"]) or normalize_key_part(c["teachingClass"]) in cur]
        if filtered:
            return filtered[0]
    return names[0] if names else None


def merge_schedule_items(items):
    """相邻节次合并 + 排序，复刻 mergeScheduleItems（省略 time 字段，build_record 不需要）。"""
    groups = {}
    for it in items:
        key = "\x00".join(str(x) for x in [it["dayOfWeek"], it["courseName"], it["location"],
                                             it["teachingClass"], it["teacher"], it["courseNo"], it["weeklyHours"]])
        groups.setdefault(key, []).append(dict(it))
    merged_all = []
    for group in groups.values():
        group.sort(key=lambda x: (x["startPeriod"], x["endPeriod"]))
        acc = []
        for it in group:
            if acc and acc[-1]["endPeriod"] + 1 >= it["startPeriod"]:
                acc[-1]["endPeriod"] = max(acc[-1]["endPeriod"], it["endPeriod"])
            else:
                acc.append(dict(it))
        merged_all.extend(acc)
    merged_all.sort(key=lambda x: (x["dayOfWeek"], x["startPeriod"], x["endPeriod"], x["courseName"]))
    return merged_all


def parse_schedule_items(main_table_html, detail_courses):
    """周课表 HTML + 明细表 → scheduleItems（含 courseNo/teacher，经明细回填）。"""
    rows = parse_table_rows(main_table_html)
    grid, placements = analyze_table(rows)
    day_columns = {}
    for col_index, cell in enumerate(grid[0] if grid else []):
        text = clean_text(cell.get("text", "") if cell else "")
        if text in DAY_LABELS:
            day_columns[col_index] = {"dayOfWeek": DAY_LABELS.index(text) + 1, "dayLabel": text}
    row_periods = {}
    for row_index, row in enumerate(grid):
        row_text = " ".join(clean_text(c.get("text", "") if c else "") for c in row)
        if re.search(r"中\s*午", row_text) or "课表说明" in row_text:
            continue
        label = clean_text((row[1].get("text") if len(row) > 1 and row[1] else "")
                           or (row[0].get("text") if row and row[0] else ""))
        periods = parse_periods_from_row_label(label)
        if periods:
            row_periods[row_index] = periods
    lookup = build_detail_lookup(detail_courses)
    raw = []
    for pl in placements:
        day = day_columns.get(pl["colIndex"])
        if not day:
            continue
        covered = []
        for off in range(pl["rowSpan"]):
            covered.extend(row_periods.get(pl["rowIndex"] + off, []))
        uniq = sorted(set(covered))
        if not uniq:
            continue
        for chunk in parse_course_chunks(pl["cell"]):
            detail = match_detail_course(chunk, lookup) or {}
            raw.append({
                "courseName": chunk["courseName"], "teacher": detail.get("teacher") or "",
                "location": chunk["location"], "dayOfWeek": day["dayOfWeek"], "dayLabel": day["dayLabel"],
                "startPeriod": uniq[0], "endPeriod": uniq[-1],
                "teachingClass": chunk["teachingClass"], "courseNo": detail.get("courseNo") or "",
                "weeklyHours": detail.get("weeklyHours") or "",
            })
    return merge_schedule_items(raw)


# ============ 登录 + 抓取 ============

def _hidden(html, name):
    m = re.search(r'name="%s"[^>]*value="([^"]*)"' % re.escape(name), html)
    return m.group(1) if m else ""


def make_session():
    s = requests.Session()
    s.headers.update({"User-Agent": UA})
    s.verify = False
    return s


def login(session, user, pwd, retries=5):
    """targetUrl 流程登录。成功=cookie SjdJsfJfXfsFsdf 存在。含 http 回跳偶发 IPv6 不可达 → 重试。"""
    last_err = None
    for _ in range(retries):
        try:
            r = session.get(f"{JWC}/sso/login.aspx", timeout=20, allow_redirects=True)
            m = re.search(r"service=([^&\"]+)", r.url)
            service = urllib.parse.unquote(m.group(1)) if m else f"{JWC}/sso/login.aspx"
            lu = f"{CAS}/login?service=" + urllib.parse.quote(service, safe="")
            page = session.get(lu, timeout=15).text
            ex = re.search(r'name="execution"\s+value="([^"]+)"', page)
            ex = ex.group(1) if ex else "e1s1"
            pubkey = session.get(f"{CAS}/jwt/publicKey", timeout=10).text.strip()
            data = {"username": user, "password": C.rsa_encrypt_password(pwd, pubkey), "execution": ex,
                    "_eventId": "submit", "geolocation": "", "currentMenu": "1", "failN": "-1",
                    "mfaState": "", "rememberMe": "false", "trustAgent": "", "fpVisitorId": ""}
            session.post(lu, data=data, timeout=20,
                         headers={"Referer": lu, "Origin": "https://uis.jxnu.edu.cn"}, allow_redirects=True)
            if AUTH_COOKIE in session.cookies.get_dict():
                return True
        except Exception as e:  # 瞬时网络（含 http 回跳 IPv6 unreachable）→ 重试
            last_err = e
            time.sleep(2)
    if last_err:
        raise last_err
    return False


def is_authed(session):
    return AUTH_COOKIE in session.cookies.get_dict()


def _kcb_url(sid):
    b64 = base64.b64encode(str(sid).encode()).decode()
    return f"{JWC}/MyControl/All_Display.aspx?UserControl=Xfz_Kcb.ascx&UserType=Student&UserNum={b64}"


def _looks_logged_out(html):
    # 会话失效标志：20 字节「参数错误」/ 学生之家「未登录」/ 跳回 CAS。
    return (len(html) < 120 and ("参数错误" in html or "请登录" in html)) or "未登录系统" in html


def list_semesters(html):
    """解析 ddlSterm → [(value, label, selected)]。"""
    m = re.search(r'<select[^>]*name="_ctl6:ddlSterm"[^>]*>(.*?)</select>', html, re.DOTALL | re.I)
    if not m:
        return []
    out = []
    for om in re.finditer(r'<option([^>]*)value="([^"]*)"[^>]*>(.*?)</option>', m.group(1), re.DOTALL):
        selected = "selected" in om.group(1).lower()
        out.append((om.group(2), clean_text(re.sub(r"<[^>]+>", "", om.group(3))), selected))
    return out


def _user_class(html):
    """从 lblUserInfor 取班级名（不取姓名，脱敏）。"""
    m = re.search(r"lblUserInfor[^>]*>(.*?)</span>", html, re.DOTALL)
    text = clean_text(re.sub(r"<[^>]+>", " ", m.group(1))) if m else ""
    cm = re.search(r"班级名称[:：]\s*(.+?)\s+学号[:：]", text)
    return clean_text(cm.group(1)) if cm else ""


def _parse_page(html):
    """一页 → (detail_courses, main_table_html)。"""
    detail_html = slice_table_html(html, "_ctl6_dgStudentLesson")
    detail_rows = parse_table_rows(detail_html) if detail_html else []
    detail_courses = parse_detail_courses(detail_rows)
    main_html = slice_table_html(html, "_ctl6_NewKcb")
    return detail_courses, main_html


def fetch_student(session, sid):
    """单次会话遍历全部学期 → build_record 的聚合输入（脱敏，不含姓名）。

    返回 {class_name, courses_by_cno(最早学期优先), latest_term(规划=ddl 默认选中), schedule_items, no_schedule}。
    会话失效自动重登录一次。
    """
    url = _kcb_url(sid)

    def _get():
        return session.get(url, timeout=25, headers={"Referer": JWC + "/"}).text

    html = _get()
    if _looks_logged_out(html):
        login(session, os.environ["XK_USERNAME"], os.environ["XK_PASSWORD"])
        html = _get()
    if _looks_logged_out(html):
        raise RuntimeError("schedule page access denied after re-login")

    sems = list_semesters(html)
    if not sems:
        raise RuntimeError("no ddlSterm on schedule page (unexpected structure)")

    # 规划学期 = ddl 默认选中项（学校口径的"本次要选/规划的学期"）；无 selected 时取首项。
    planning_value, planning_label = None, None
    for value, label, selected in sems:
        if selected:
            planning_value, planning_label = value, label
            break
    if planning_label is None:
        planning_value, planning_label = sems[0][0], sems[0][1]

    class_name = _user_class(html)

    # 逐学期抓明细（旧→新），courses_by_cno 首次出现（最早学期）为准。
    # 页面链式回传：拿到的 html 已是某学期，其余学期 POST 切换。
    pages = {}  # value -> (detail_courses, main_html)
    default_detail, default_main = _parse_page(html)
    default_value = next((v for v, _l, sel in sems if sel), sems[0][0])
    pages[default_value] = (default_detail, default_main)

    cur_html = html
    for value, label, _sel in sems:
        if value in pages:
            continue
        form = {
            "__EVENTTARGET": "", "__EVENTARGUMENT": "",
            "__VIEWSTATE": _hidden(cur_html, "__VIEWSTATE"),
            "__VIEWSTATEGENERATOR": _hidden(cur_html, "__VIEWSTATEGENERATOR"),
            "__EVENTVALIDATION": _hidden(cur_html, "__EVENTVALIDATION"),
            "_ctl6:ddlSterm": value, "_ctl6:btnSearch": "确定",
        }
        resp = session.post(url, data=form, timeout=25,
                            headers={"Referer": url, "Content-Type": "application/x-www-form-urlencoded"})
        cur_html = resp.text
        if _looks_logged_out(cur_html):
            login(session, os.environ["XK_USERNAME"], os.environ["XK_PASSWORD"])
            cur_html = _get()
            continue
        pages[value] = _parse_page(cur_html)
        if not class_name:
            class_name = _user_class(cur_html)

    # 旧→新聚合（sems 是新→旧，倒序即旧→新）。
    label_of = {v: l for v, l, _s in sems}
    courses_by_cno = {}
    for value, label, _sel in reversed(sems):
        page = pages.get(value)
        if not page:
            continue
        detail_courses, _main = page
        for dc in detail_courses:
            cno = (dc.get("courseNo") or "").strip()
            if not cno:
                continue
            if cno not in courses_by_cno:
                courses_by_cno[cno] = {
                    "courseName": (dc.get("courseName") or "").strip(),
                    "teacher": (dc.get("teacher") or "").strip(),
                    "teachingClass": (dc.get("teachingClass") or "").strip(),
                    "semester": label_of.get(value, ""),
                }

    # 规划学期周课表 → scheduleItems。
    plan_detail, plan_main = pages.get(planning_value, (default_detail, default_main))
    schedule_items = parse_schedule_items(plan_main, plan_detail) if plan_main else []
    no_schedule = len(schedule_items) == 0

    return {
        "class_name": class_name,
        "courses_by_cno": courses_by_cno,
        "latest_term": planning_label,
        "schedule_items": schedule_items,
        "no_schedule": no_schedule,
    }


# ============ CLI（本地/VPS 冒烟测试） ============

def main():
    import argparse
    import json
    ap = argparse.ArgumentParser(description="教务实时抓取一名学生 → record_json（脱敏）")
    ap.add_argument("sid")
    ap.add_argument("--master", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "master"))
    ap.add_argument("--raw", action="store_true", help="只打印聚合输入，不联表")
    args = ap.parse_args()

    user = os.environ.get("XK_USERNAME")
    pwd = os.environ.get("XK_PASSWORD")
    if not user or not pwd:
        sys.exit("需要 XK_USERNAME / XK_PASSWORD 环境变量")

    requests.packages.urllib3.disable_warnings()  # type: ignore[attr-defined]
    s = make_session()
    t0 = time.monotonic()
    login(s, user, pwd)
    agg = fetch_student(s, args.sid)
    if args.raw:
        print(json.dumps(agg, ensure_ascii=False, indent=2))
        return
    import student_record_lib as L
    ctx = L.load_master_ctx(args.master)
    result = L.build_record(args.sid, agg["class_name"], agg["courses_by_cno"],
                            agg["latest_term"], agg["schedule_items"], agg["no_schedule"], ctx)
    rec = result["record"]
    print(json.dumps({
        "elapsedSec": round(time.monotonic() - t0, 1),
        "className": result["row"]["class_name"],
        "planKey": result["row"]["plan_key"],
        "totalEarned": result["row"]["total_earned"],
        "takenCount": result["row"]["taken_count"],
        "planningSemester": rec["planningSemester"],
        "readingPlanTerm": rec["readingPlanTerm"],
        "scheduleItems": len(rec["scheduleItems"]),
        "detailCourses": len(rec["detailCourses"]),
        "hasName": "姓名" in json.dumps(rec, ensure_ascii=False),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
