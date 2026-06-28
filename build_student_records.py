"""
学生档案 build —— studentjson/ 的 8 份学期快照 → D1 student_records 表的 SQL dump。

输入：
  studentjson/*.json    （学校教务导出的全校课表快照；data=有课表，failures=该学期确认无课表）
  data/master/courses.json          （联学分用：courseNo→credits）
  data/master/plan_courses.json     （planKey 集合，校验匹配）
  data/master/major_requirements.json（planKey 集合，校验匹配）

输出：
  studentjson/out/student_records_NN.sql  分块的 INSERT OR REPLACE，配合
    npx wrangler d1 execute jxnu-ratings --remote --file=studentjson/out/student_records_01.sql
    ... 逐个 import。

不修改任何源数据；幂等，重跑覆盖。
"""

import json
import os
import re
import sys
import glob
from collections import defaultdict

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# ============ 路径 ============
STUDENTJSON_DIR = "studentjson"
OUT_DIR = os.path.join(STUDENTJSON_DIR, "out")
MASTER_COURSES_FILE = os.path.join("data", "master", "courses.json")
MASTER_PLANS_FILE = os.path.join("data", "master", "plan_courses.json")
MASTER_REQS_FILE = os.path.join("data", "master", "major_requirements.json")

# 每个 SQL 文件最多多少条 INSERT —— wrangler d1 execute 对单文件 SQL 有体量上限，分块更稳。
CHUNK_SIZE = 2000


# ============ 工具 ============

def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def sql_str(s):
    """转义为 SQL 字符串字面量；内部单引号双写；None→NULL（无引号）。"""
    if s is None:
        return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def sql_num(v):
    if v is None:
        return "NULL"
    try:
        n = float(v)
        if n != n:  # NaN
            return "NULL"
        # int-y 输出整型，省字节
        if n.is_integer():
            return str(int(n))
        return repr(n)
    except (TypeError, ValueError):
        return "NULL"


# ============ className → planKey ============

# 全角化（半角括号→全角，方便统一匹配 mr/pc 的 planKey 形态）。
def to_full_paren(s):
    return (s or "").replace("(", "（").replace(")", "）")


# 提取「N班」及后缀括号。返回 (body, suffix_paren or "")
_class_tail_re = re.compile(r"(\d+)?班\s*(?:（([^）]*)）)?\s*$")


def parse_classname(cn):
    """className → (year, body, mid_paren, tail_paren)；不可解析返回 None。"""
    if not cn:
        return None
    cn = to_full_paren(cn.strip())
    m = re.match(r"^(\d{2})级", cn)
    if not m:
        return None
    yr = 2000 + int(m.group(1))
    rest = cn[m.end():]
    tail = _class_tail_re.search(rest)
    if not tail:
        return None
    tail_paren = tail.group(2) or ""
    body_full = rest[: tail.start()].strip()
    # 体内中段括号（如「环境设计（室内设计）」「计算机科学与技术（师范）」）
    mid_paren = ""
    mid_m = re.search(r"（([^）]*)）", body_full)
    if mid_m:
        mid_paren = mid_m.group(1)
    body_clean = re.sub(r"（[^）]*）", "", body_full).strip()
    return yr, body_clean, mid_paren, tail_paren


# 特殊通识必修白名单：不进常规周课表、但全员必修且默认已修（如红色文化/劳动教育概论）。
# 规则：方案要求(ti<=在读)且学生档案里没出现 → 补算为已修，确保已修学分不漏算。
SPECIAL_CREDIT_CIDS = {"028021", "028022", "028023", "028020", "024001"}  # 红色文化 / 劳动教育概论 / 劳动教育概论（实践）/ 思政实践课 / 毕业设计（论文）/

# 师范类修饰词（班级名出现这些 → 优先师范变体）。
_SHIFAN_HINTS = ["公费师范生", "国家公费师范生", "公费师范", "师范"]
# 非师范专业的"普通班"默认变体优先级 —— 班级名无修饰时优先猜这些（综合型最通用）。
_NONSHIFAN_DEFAULTS = ["综合型", "学术型", "普通", "非师范"]


def classname_to_plankey_candidates(cn, valid_keys):
    """
    返回按优先级排序的候选 planKey（已与 valid_keys 求交）。弱匹配：班级名与方案不对称是常态，
    宁可不瞎猜师范——非师范班级名优先「综合型」等普通变体，师范变体仅在班级名含「师范」字样时优先，
    否则降到最末兜底（仅当该专业只有师范变体时才用）。猜错由前端「识别错误?点击修改」兜底。
    """
    parsed = parse_classname(cn)
    if not parsed:
        return []
    yr, body, mid, tail = parsed
    prefix = f"{yr}级-"
    is_shifan_class = any(h in (tail or "") or h in (mid or "") for h in _SHIFAN_HINTS)

    candidates = []

    def add(major):
        if not major:
            return
        key = prefix + major
        if key in valid_keys and key not in candidates:
            candidates.append(key)

    # 1) 干净主体精确匹配（无修饰）
    add(body)
    # 2) 班级名自带括号修饰（中段/尾缀全名，如 "环境设计（室内设计）"）
    if mid:
        add(f"{body}（{mid}）")
    if tail:
        add(f"{body}（{tail}）")
    # 3) 班级名含师范字样 → 优先师范变体
    if is_shifan_class:
        for v in _SHIFAN_HINTS:
            add(f"{body}（{v}）")
    # 4) 普通班默认：综合型 > 学术型 > …（非师范优先，修掉"无修饰被错配师范"）
    for v in _NONSHIFAN_DEFAULTS:
        add(f"{body}（{v}）")
    # 5) 最末兜底师范：仅当该专业只有师范变体（多见于纯师范专业）
    if not is_shifan_class:
        for v in _SHIFAN_HINTS:
            add(f"{body}（{v}）")

    return candidates


def classname_to_plankey(cn, valid_keys):
    cands = classname_to_plankey_candidates(cn, valid_keys)
    return cands[0] if cands else None


# ============ schedule 字段拼成 "星期X-第N节" / "第MN节" ============

def fmt_period(start, end):
    try:
        s = int(start)
    except (TypeError, ValueError):
        return ""
    try:
        e = int(end) if end is not None else s
    except (TypeError, ValueError):
        e = s
    if e < s:
        s, e = e, s
    if e == s:
        return f"第{s}节"
    # 枚举区间内每一节再拼接，parseSchedule 按 1[0-2]|[1-9] 切分：
    # 第89节→8,9；第345节→3,4,5（区间端点不相邻时也能展开中间节次）。
    body = "".join(str(p) for p in range(s, e + 1))
    return f"第{body}节"


def fmt_schedule(item):
    day = (item.get("dayLabel") or "").strip()
    pd = fmt_period(item.get("startPeriod"), item.get("endPeriod"))
    if day and pd:
        return f"{day}-{pd}"
    return day or pd


# ============ 培养方案学期推算（复刻 src/lib/term.ts） ============
# 与 creditPlan.ts 的 REQUIRED_NATURES 对齐（plan_courses 的 nature 已归一化）。
REQUIRED_NATURES = ["公共必修课", "专业主干", "专业类基础", "教师教育必修"]
_CN_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "十一": 11, "十二": 12}


def enroll_year_of(plan_key, class_name):
    """入学年：优先 planKey 的 4 位，其次 className 的 2 位前缀。取不到 None。"""
    if plan_key:
        m = re.search(r"(\d{4})", plan_key)
        if m:
            return int(m.group(1))
    if class_name:
        m = re.match(r"^\s*(\d{2})", class_name)
        if m:
            return 2000 + int(m.group(1))
    return None


def parse_student_sem(label):
    """学生学期 "25-26第2学期" → (year, season)。第1学期=前一年秋，第2学期=后一年春。取不到 None。"""
    if not label:
        return None
    m = re.search(r"(\d{2})-(\d{2})第(\d+)学期", label)
    if not m:
        return None
    y1, y2, n = 2000 + int(m.group(1)), 2000 + int(m.group(2)), int(m.group(3))
    return (y1, "秋") if n % 2 == 1 else (y2, "春")


def plan_term_from_cal(enroll_y, cal):
    """复刻 currentPlanTerm：秋=(year-enrollY)*2+1；春=(year-1-enrollY)*2+2。无效返回 0。"""
    if enroll_y is None or not cal:
        return 0
    year, season = cal
    cur = (year - enroll_y) * 2 + 1 if season == "秋" else (year - 1 - enroll_y) * 2 + 2
    return max(1, cur)


def previous_cal_term(cal):
    """规划快照学期 → 当下在读学期。秋季规划的前一学期是同年春，春季规划的前一学期是上年秋。"""
    if not cal:
        return None
    year, season = cal
    return (year, "春") if season == "秋" else (year - 1, "秋")


def cal_term_key(cal):
    """(year, 春/秋) → 前端统一学期 key YYYY-03 / YYYY-09。"""
    if not cal:
        return ""
    year, season = cal
    return f"{year}-{'03' if season == '春' else '09'}"


def snapshot_sort_key(path):
    """按文件内 termValue (year, month) 排时间序 —— 不依赖文件名（中文/编号都可能乱序）。"""
    try:
        head = open(path, encoding="utf-8").read(16384)
        m = re.search(r'"termValue"\s*:\s*"(\d{4})/(\d{1,2})/', head)
        if m:
            return (int(m.group(1)), int(m.group(2)))
    except OSError:
        pass
    return (9999, 99)


def snapshot_term_label(snapshot):
    """从快照的完整记录提取统一学期标签，供无课表 failures 记录复用。"""
    labels = {
        str(row.get("termLabel") or "").strip()
        for row in (snapshot.get("data") or [])
        if str(row.get("termLabel") or "").strip()
    }
    if len(labels) != 1:
        raise ValueError(f"快照 termLabel 应唯一，实际为: {sorted(labels)}")
    return next(iter(labels))


def cn_term_index(label):
    """plan_courses 的 "第N学期"/"第十学期" → N；取不到 0。复刻 termIndexOf。"""
    if not label:
        return 0
    m = re.search(r"第\s*(\d+)\s*学期", label)
    if m:
        return int(m.group(1))
    m2 = re.search(r"第\s*([一二三四五六七八九十]+)\s*学期", label)
    if m2 and m2.group(1) in _CN_NUM:
        return _CN_NUM[m2.group(1)]
    return 0


# ============ 主流程 ============

def main():
    if not os.path.isdir(STUDENTJSON_DIR):
        sys.exit(f"找不到 {STUDENTJSON_DIR}/")

    print("载入 master/courses.json …")
    master = load_json(MASTER_COURSES_FILE)
    credit_of = {str(c.get("id", "")): c.get("credits") for c in master if c.get("id")}
    print(f"  master 课程: {len(credit_of)} 条")

    print("载入 plan_courses + major_requirements 用作 planKey 集合 …")
    pc = load_json(MASTER_PLANS_FILE)
    mr = load_json(MASTER_REQS_FILE)
    valid_keys = set(pc.keys() if isinstance(pc, dict) else [])
    for e in mr if isinstance(mr, list) else []:
        y, mj = e.get("year"), e.get("major")
        if y and mj:
            valid_keys.add(f"{y}级-{mj}")
    print(f"  planKey 集合: {len(valid_keys)} 个")

    # 学生聚合容器（脱敏：不保留姓名）
    # students[sid] = {
    #   "className": last seen, "latest_*": 最新快照信息,
    #   "courses": dict[courseNo] -> {courseName, teacher, teachingClass, semester(最早出现的 termLabel)}
    # }
    # 门数以 courseNo 为唯一键：同一课程号严格算一门（重修/多班级不重复计数）。
    students = {}
    # 按文件内 termValue 排时间序（不靠文件名），idx 越大 = 越新 → 用于"最新快照"判断。
    snapshot_files = sorted(glob.glob(os.path.join(STUDENTJSON_DIR, "*.json")), key=snapshot_sort_key)
    print(f"读取 {len(snapshot_files)} 份快照 …")
    missing_credit_codes = set()

    for idx, path in enumerate(snapshot_files):
        snap = load_json(path)
        rows = snap.get("data", []) or []
        print(f"  {os.path.basename(path)}: {len(rows)} 名学生")
        for s in rows:
            sid = str(s.get("studentId") or "").strip()
            if not sid:
                continue
            rec = students.setdefault(sid, {
                "className": "",
                "courses": {},
                "latest_idx": -1,
                "latest_term": "",
                "latest_schedule": [],
                "latest_no_schedule": False,
            })
            cls = str(s.get("className") or "").strip()
            # className 取最新一份（学生升级换班的话用最近的）
            if cls and idx >= rec["latest_idx"]:
                rec["className"] = cls

            term_label = str(s.get("termLabel") or "").strip()

            for dc in (s.get("detailCourses") or []):
                cno = str(dc.get("courseNo") or "").strip()
                if not cno:
                    continue
                # 同 cno 多次（重修/跨学期）只保留一份，semester 用最早记录
                cur = rec["courses"].get(cno)
                if cur is None:
                    rec["courses"][cno] = {
                        "courseName": str(dc.get("courseName") or "").strip(),
                        "teacher": str(dc.get("teacher") or "").strip(),
                        "teachingClass": str(dc.get("teachingClass") or "").strip(),
                        "semester": term_label,
                    }
                else:
                    # 课名/教师如果之前为空，补一下
                    if not cur["courseName"] and dc.get("courseName"):
                        cur["courseName"] = str(dc["courseName"]).strip()
                    if not cur["teacher"] and dc.get("teacher"):
                        cur["teacher"] = str(dc["teacher"]).strip()

            # scheduleItems: 仅保留"最新一份快照"的（用于未来 26 秋导入后直接渲染下学期）
            sched = s.get("scheduleItems") or []
            if idx >= rec["latest_idx"]:
                rec["latest_idx"] = idx
                rec["latest_term"] = term_label
                rec["latest_schedule"] = sched
                rec["latest_no_schedule"] = False

        # failures 是本快照中“确认无课表”的学生，不是应丢弃的抓取残次。
        # 仍将其最新学期推进到本快照，课表置空；历史课程/学分继续保留。
        # 从未有过完整记录的学号也建立空档案，保证每份全校快照的人员全集不丢失。
        failures = snap.get("failures", []) or []
        term_label = snapshot_term_label(snap)
        successful_ids = {
            str(row.get("studentId") or "").strip()
            for row in rows
            if str(row.get("studentId") or "").strip()
        }
        no_schedule_count = 0
        for failure in failures:
            sid = str(failure.get("studentId") or "").strip()
            if not sid or sid in successful_ids:
                continue
            rec = students.setdefault(sid, {
                "className": "",
                "courses": {},
                "latest_idx": -1,
                "latest_term": "",
                "latest_schedule": [],
                "latest_no_schedule": False,
            })
            if idx >= rec["latest_idx"]:
                rec["latest_idx"] = idx
                rec["latest_term"] = term_label
                rec["latest_schedule"] = []
                rec["latest_no_schedule"] = True
            no_schedule_count += 1
        print(f"    无课表: {no_schedule_count} 名；本快照人员合计: {len(successful_ids) + no_schedule_count} 名")

    print(f"\n合并后：去重学生 {len(students)} 名")

    # 把每个学生映射成最终 row + record_json
    out_rows = []
    matched_plan = 0
    missing_plan_samples = []
    pc_map = pc if isinstance(pc, dict) else {}

    for sid in sorted(students.keys()):
        rec = students[sid]

        # 0) className → planKey + 入学年 + 在读培养方案学期 + 该方案 nature/必修全集。
        # studentjson 最新快照代表“本次要规划/选课的学期”，不是当前在读学期：
        # 26-27第1学期 = 2026-09 规划目标，因此在读仍是它前一学期 2026-03。
        plan_key = classname_to_plankey(rec["className"], valid_keys)
        enroll_y = enroll_year_of(plan_key, rec["className"])
        planning_cal = parse_student_sem(rec["latest_term"])
        planning_semester = cal_term_key(planning_cal)
        reading_plan_term = plan_term_from_cal(enroll_y, previous_cal_term(planning_cal))
        plan_courses_list = pc_map.get(plan_key) or []
        nature_of = {c["cid"]: c["nature"] for c in plan_courses_list}
        required_up_to_reading = []
        if reading_plan_term > 0:
            for c in plan_courses_list:
                if c["nature"] in REQUIRED_NATURES and 0 < cn_term_index(c["semester"]) <= reading_plan_term:
                    required_up_to_reading.append(c["cid"])

        # 1) detailCourses 联学分 + nature + planTermIndex
        detail_out = []
        total_earned = 0.0
        for cno, info in rec["courses"].items():
            credits = credit_of.get(cno)
            if credits is None:
                missing_credit_codes.add(cno)
                credits = 0
            pti = plan_term_from_cal(enroll_y, parse_student_sem(info["semester"]))
            detail_out.append({
                "courseId": cno,
                "courseName": info["courseName"],
                "credits": credits,
                "semester": info["semester"] or None,
                "planTermIndex": pti,
                "nature": nature_of.get(cno),
                "teacher": info["teacher"] or None,
                "teachingClass": info["teachingClass"] or None,
            })
            # 教务总学分不含当前在读学期，更不能把规划学期的预排课程算成已修。
            # 学期未知(pti=0)的历史课沿用旧行为计入，避免无标签旧数据被整体漏算。
            if reading_plan_term <= 0 or pti == 0 or pti < reading_plan_term:
                try:
                    total_earned += float(credits)
                except (TypeError, ValueError):
                    pass

        # 1b) 特殊通识必修补算（红色文化/劳动教育概论等不进课表的全员必修）：
        #     方案要求(ti<=在读)且档案里没有 → 补进 detailCourses 视为已修，避免漏算学分。
        if reading_plan_term > 0:
            existing = set(rec["courses"].keys())
            for c in plan_courses_list:
                cid = c["cid"]
                if cid not in SPECIAL_CREDIT_CIDS or cid in existing:
                    continue
                ti = cn_term_index(c["semester"])
                if not (0 < ti <= reading_plan_term):
                    continue
                cr = credit_of.get(cid)
                if cr is None:
                    cr = c.get("credits") or 0
                detail_out.append({
                    "courseId": cid,
                    "courseName": c["name"],
                    "credits": cr,
                    "semester": None,
                    "planTermIndex": ti,
                    "nature": c["nature"],
                    "teacher": None,
                    "teachingClass": None,
                    "supplemented": True,  # 标记：白名单补算，非课表来源
                })
                try:
                    total_earned += float(cr)
                except (TypeError, ValueError):
                    pass

        # 2) scheduleItems 形态对齐 StudentScheduleItem
        schedule_out = []
        for item in rec["latest_schedule"]:
            cno = str(item.get("courseNo") or "").strip()
            schedule_out.append({
                "courseId": cno,
                "courseName": str(item.get("courseName") or "").strip(),
                "teacher": str(item.get("teacher") or "").strip() or None,
                "classroom": str(item.get("location") or "").strip() or None,
                "schedule": fmt_schedule(item) or None,
                "credits": credit_of.get(cno),
                # 原始字段也带上，前端如需周次/分时刻可读
                "dayOfWeek": item.get("dayOfWeek"),
                "startPeriod": item.get("startPeriod"),
                "endPeriod": item.get("endPeriod"),
            })

        # 3) planKey 命中统计（plan_key 已在上方算好）
        if plan_key:
            matched_plan += 1
        elif rec["className"] and len(missing_plan_samples) < 12:
            missing_plan_samples.append(rec["className"])

        record_json = {
            "studentId": sid,
            "className": rec["className"] or None,
            "termLabel": rec["latest_term"] or None,
            # 最新 studentjson 是本次模拟选课的规划目标；readingPlanTerm 是其前一在读学期。
            "planningSemester": planning_semester or None,
            # true = 该生出现在快照 failures，语义为本学期确认无课表；不是待重试错误。
            "noSchedule": rec["latest_no_schedule"],
            # 在读培养方案第几学期（前端据此区分往期/本学期/自动填在读学期）。
            "readingPlanTerm": reading_plan_term or None,
            # 培养方案 ti<=在读 的必修 cid 全集 —— 前端用「全集 − 已修」自动算「核对必修」排除项。
            "requiredCidsUpToReading": required_up_to_reading,
            "scheduleItems": schedule_out,
            "detailCourses": detail_out,
        }

        out_rows.append({
            "student_id": sid,
            "class_name": rec["className"],
            "plan_key": plan_key,
            "total_earned": round(total_earned, 2),
            "taken_count": len(detail_out),  # detail_out 已按 courseNo 去重 → 门数与课程号强绑定
            "record_json": json.dumps(record_json, ensure_ascii=False),
        })

    print(f"  planKey 命中: {matched_plan}/{len(out_rows)} = {matched_plan*100//max(1,len(out_rows))}%")
    print(f"  courseNo 缺学分: {len(missing_credit_codes)} 个（按 0 学分计）")
    if missing_plan_samples:
        print(f"  未命中 className 例:")
        for s in missing_plan_samples:
            print(f"    {s}")

    # ============ 写 SQL ============
    os.makedirs(OUT_DIR, exist_ok=True)
    # 清理旧 chunk
    for old in glob.glob(os.path.join(OUT_DIR, "student_records_*.sql")):
        os.remove(old)

    cols = "(student_id, class_name, plan_key, total_earned, taken_count, record_json)"
    total_chunks = (len(out_rows) + CHUNK_SIZE - 1) // CHUNK_SIZE
    for ci in range(total_chunks):
        chunk = out_rows[ci * CHUNK_SIZE : (ci + 1) * CHUNK_SIZE]
        out_path = os.path.join(OUT_DIR, f"student_records_{ci+1:02d}.sql")
        with open(out_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(f"-- chunk {ci+1}/{total_chunks}, {len(chunk)} rows\n")
            for r in chunk:
                f.write(
                    f"INSERT OR REPLACE INTO student_records {cols} VALUES ("
                    f"{sql_str(r['student_id'])}, "
                    f"{sql_str(r['class_name'])}, "
                    f"{sql_str(r['plan_key'])}, "
                    f"{sql_num(r['total_earned'])}, "
                    f"{sql_num(r['taken_count'])}, "
                    f"{sql_str(r['record_json'])}"
                    f");\n"
                )
        print(f"  -> {out_path} ({len(chunk)} rows)")

    print(f"\nDone. 共 {len(out_rows)} 行，分 {total_chunks} 个 SQL 文件。")
    print("部署：对每个 chunk 执行：")
    print("  npx wrangler d1 execute jxnu-ratings --remote --file=studentjson/out/student_records_01.sql")
    print("  （首次记得先 d1 execute --file=d1_schema.sql 建表）")


if __name__ == "__main__":
    main()
